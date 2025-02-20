"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("child_process");
const { DatabaseSync, StatementSync } = require("node:sqlite");
const { Dex, Teams, toID } = require("./pokemon-showdown/dist/sim/index.js");

module.exports = class {

	#metagamesObject = {};
	get metagamesObject() {
		return this.#metagamesObject;
	}

	// does not include pokemon; just a convenient list of metagames.
	#metagamesArray = [];
	get metagamesArray() {
		return this.#metagamesArray;
	}

	#gametypes = {};

	/** @type {DatabaseSync} */
	#db = null;

	/** @type {Object.<string, StatementSync>} */
	stmt = null;

	#metagamesBF = [];
	get metagamesBF() {
		return this.#metagamesBF;
	}

	#generatorBF = null;

	#psbots = null;
	get psbots() {
		return this.#psbots;
	}

	constructor(bf) {
		this.#prepareDB();
		if(bf) {
			const bf = Dex.formats.get("gen9battlefactory");
			this.#generatorBF = Teams.getGenerator(bf);
		}
	}

	#prepareDB() {
		const dbpath = path.join(__dirname, "players.db");
		const stpath = path.join(__dirname, "statements.sql");
		this.#db = new DatabaseSync(dbpath);
		const statements = fs.readFileSync(stpath, { encoding: "utf-8" });
		this.stmt = {};
		const interpreter = /---(.+?)\n(.+?);/gs;
		while(true) {
			const i = interpreter.exec(statements);
			if(!i) break;
			if(i[1] === "STARTUP") {
				this.#db.exec(i[2]);
			}
			else {
				this.stmt[i[1]] = this.#db.prepare(i[2]);
			}
		}
	}

	/**
	 * Ensures that a metagames index is available.
	 */
	async init() {
		const PATH_METAGAMES = path.join(__dirname, "metagames");
		const errors = [];
		if(!fs.existsSync(PATH_METAGAMES)) {
			const errors_fetch = await this.fetchMetagames();
			errors.push(...errors_fetch);
		}
		const errors_load = await this.loadMetagames();
		errors.push(...errors_load);

		if(!this.#generatorBF) return errors;

		try {
			const psbots = require("./PSBots.js");
			const configPath = path.join(__dirname, "config.json");
			const { psAuth } = require(configPath);
			this.#psbots = new psbots(psAuth);
			await this.#psbots.connect();
		}
		catch(err) {
			errors.push(err);
		}

		return errors;
	}

	/**
	 * Pokemon species specification in challenge codes are slightly different from that in the teambuilder, and way more strict.
	 * @param {string} mon - input pokemon
	 * @returns {string | null} - normalized pokemon or null if missing from dex
	 */
	toChalCode(mon) {
		const species_input = Dex.species.get(mon);

		if(!species_input.exists) return null;
		
		const species_base = Dex.species.get(species_input.baseSpecies);
		let species_effective = species_base.cosmeticFormes?.includes(species_input.name)
		? species_base
		: species_input;

		// 35 Pokes legality exceptions

		// only weight is different
		if(species_effective.name === "Dudunsparce") return species_effective.name;

		// Note: Those pokemon which are part of another's otherFormes don't have otherFormes themselves.

		return species_effective.otherFormes
		? `${species_effective.name}-Base`
		: species_effective.name;
	}

	/**
	 * Parses the provided replay .log into relevant information.
	 * @param {string} URL - a Pokemon Showdown replay URL.
	 */
	async validate(URL) {
		const log_res = await fetch(URL);
		if(!log_res.ok) return { errors: [`Resource fetch failed: ${URL}`] };
		const log_txt = await log_res.text();
		const log = log_txt.split("\n");

		const errors = [];

		let timestamp = null;
		let gametype = "singles";
		let winner = -1;

		const battle = [];
		const appearances = [];
		const formats = new Map(); // unique meta name -> violations

		for(const line of log) {
			const data = line.split("|").filter((x) => x);
			switch(data[0]) {

				// Sample: "|t:|1736869087"
				// Appears everywhere; we only care about the earliest instance.
				case "t:": {
					timestamp ??= Number(data[1]);
					break;
				}

				// Sample: "|player|p1|demirab1|lucas|"
				// Sample: "|player|p1|" (after player left)
				// Appears at the start of a battle and whenever a player subs in for another.
				case "player": {
					if(!data[2]) break;
					const side = Number(data[1].slice(1,2)) - 1;
					if(Number.isNaN(side)) {
						errors.push(`Invalid player side in ${line} (has the battle log syntax changed?)`);
						continue;
					}
					battle[side] ??= {};
					battle[side].player = data[2];
					break;
				}

				// Sample: "|poke|p2|Raichu-Alola, F|"
				// Appears only during team preview.
				case "poke": {
					const side = Number(data[1].slice(1,2)) - 1;
					if(Number.isNaN(side)) {
						errors.push(`Invalid player side in ${line} (has the battle log syntax changed?)`);
						continue;
					}
					const speciesName = data[2].split(", ")[0];
					const species = Dex.species.get(speciesName);
					if(!species.exists) {
						errors.push(`Invalid species name ${speciesName} on side ${side + 1} during preview (is the Pokemon Showdown package up to date?)`);
						continue;
					}
					battle[side] ??= {};
					battle[side].preview ??= [];
					battle[side].preview.push(species.name);
					break;
				}

				// Sample: "|switch|p1a: Seismitoad|Seismitoad, F|351/351|[from] Baton Pass"
				// Sample: "|switch|p1a: Erm ackshually|Leavanny, M|100/100"
				// This reveals more than team preview.
				case "switch": {
					const side = Number(data[1].split(":")[0].slice(1,2)) - 1;
					if(Number.isNaN(side)) {
						errors.push(`Invalid player side in ${line} (has the battle log syntax changed?)`);
						continue;
					}
					const speciesName = data[2].split(", ")[0];
					const species = Dex.species.get(speciesName);
					if(!species.exists) {
						errors.push(`Invalid species name ${speciesName} on side ${side + 1} during switch (is the Pokemon Showdown package up to date?)`);
						continue;
					}
					battle[side] ??= {};
					battle[side].reveals ??= new Set();
					battle[side].reveals.add(species.name);
					// this is rlly heavy handed ...
					if(species.baseSpecies !== species.name) {
						battle[side].reveals.delete(species.baseSpecies);
					}
					break;
				}

				// Appears
				case "win": {
					winner = battle.findIndex((x) => x.player === data[1]);
					break;
				}

				// Sample: "|detailschange|p2a: Tortuice WRLD|Terapagos-Terastal, M"
				// Appears when a pokemon changes formes.
				case "detailschange": {
					const side = Number(data[1].split(":")[0].slice(1,2)) - 1;
					if(Number.isNaN(side)) {
						errors.push(`Invalid player side in ${line} (has the battle log syntax changed?)`);
						continue;
					}
					const speciesName = data[2].split(", ")[0];
					const species = Dex.species.get(speciesName);
					if(!species.exists) {
						errors.push(`Invalid species name ${speciesName} on side ${side + 1} during transformation (is the Pokemon Showdown package up to date?)`);
						continue;
					}
					battle[side] ??= {};
					battle[side].reveals ??= new Set();
					battle[side].reveals.delete(species.baseSpecies);
					battle[side].reveals.add(species.name);
					break;
				}

				// Appears once at the start of every battle.
				case "gametype": {
					gametype = data[1];
					break;
				}

			}
		}

		for(const side of battle) {
			side.pokemon = [];
			const checked = new Set();

			// Majority of replays have reveals and a preview. We'll cross check them to fill in the blanks.
			if(side.reveals && side.preview) {
				for(const mon of side.reveals) {
					const species = Dex.species.get(mon); // exists; we ensured this above.
					const selfIndex = side.preview.indexOf(species.name);

					const baseSpecies = Dex.species.get(species.baseSpecies);
					const baseIndex = side.preview.indexOf(baseSpecies.name);

					if(baseSpecies.cosmeticFormes?.includes(species.name)) {
						side.pokemon.push(baseSpecies.name);
						checked.add(selfIndex);
						continue;
					}
					
					if(selfIndex !== -1) {
						side.pokemon.push(species.name);
						checked.add(selfIndex);
						continue;
					}
					
					if(baseIndex !== -1) {
						side.pokemon.push(species.name);
						checked.add(baseIndex);
						continue;
					}

					errors.push(`Impossible appearance of ${mon} on ${side.player} side.`);
				}
				side.pokemon.push(...side.preview.filter((mon, i) => !checked.has(i)));
			}

			// No team preview replays should always reach here.
			else if(side.reveals) {
				side.pokemon.push(...side.reveals);
			}

			// Someone forfeited at team preview.
			else if(side.preview) {
				side.pokemon.push(...side.preview);
			}

			// Invalid replay.
			else {
				errors.push(`Could not find preview or reveals for ${side.player} (have we failed to handle someone subbing in?)`);
			}

		}

		for(const { pokemon } of battle) {
			appearances.push(...pokemon);
		}
		const pokemon = new Set(appearances);

		for(const group in this.#metagamesObject) {
			for(const meta in this.#metagamesObject[group]) BLOCK_META: {

				// Prevent singles validating for doubles, etc.
				const formatName = `${group}/${meta}`;
				if(gametype === "singles"){
					for(const x in this.#gametypes){
						if(this.#gametypes[x].includes(group) || this.#gametypes[x].includes(formatName)){
							break BLOCK_META;
						}
					}
				}
				else{
					if(!this.#gametypes[gametype]?.includes(group) && !this.#gametypes[gametype]?.includes(formatName)){
						break BLOCK_META;
					}
				}

				const format = this.#metagamesObject[group][meta].filter((x) => !x.header).map((x) => x.value);
				const violations = [];

				for(const mon of pokemon) {
					if(!format.includes(mon)) violations.push(mon);
				}

				formats.set(formatName, violations);
				
			}
		}

		// PS for future me: allow unrated challenges to use specified format for 35bf.

		return {
			appearances,
			formats,
			winner,
			timestamp,
			battle,
			errors,
		};
	}

	/**
	 * Downloads the latest metagames index repository and stores it on the disk, overwriting previous instance.
	 */
	async fetchMetagames() {
		const URL_REPO = "https://api.github.com/repos/swordfishtr/35PokesIndex/tarball/main";
		//const URL_REPO = "https://api.github.com/repos/swordfishtr/35PokesIndex/tarball/next";
		const PREFIX_REPO = "swordfishtr-35PokesIndex";
		const NAME_METAGAMES = "metagames";

		const errors = [];

		// Set up tar to await input to uncompress and extract to parent dir.
		const PROC_UNPACK = spawn("tar", ["-C", __dirname, "-xzf", "-"]);
		PROC_UNPACK.stderr.setEncoding("utf-8");
		PROC_UNPACK.stderr.on("data", errors.push);

		// Set up curl to output only the response contents, then send that to tar.
		const PROC_FETCH = spawn("curl", ["-sfLm", "600", URL_REPO]);
		PROC_FETCH.stderr.setEncoding("utf-8");
		PROC_FETCH.stderr.on("data", errors.push);

		PROC_FETCH.stdout.pipe(PROC_UNPACK.stdin);

		// Will settle after at most 10 min.
		const codes = await Promise.allSettled([
			new Promise((res) => {
				PROC_FETCH.once("close", res);
			}),
			new Promise((res) => {
				PROC_UNPACK.once("close", res);
			}),
		]);

		if(!codes.every((x) => x.value === 0)) return errors;

		try {
			const PATH_NEW = path.join(__dirname, NAME_METAGAMES);
			await fs.promises.rm(PATH_NEW, { recursive: true, force: true });
			const contents = await fs.promises.readdir(__dirname);
			const target = contents.find((x) => x.startsWith(PREFIX_REPO));
			if(!target) throw new Error(`Unpacked data starting with \`${PREFIX_REPO}\` not found.`);
			const PATH_OLD = path.join(__dirname, target);
			await fs.promises.rename(PATH_OLD, PATH_NEW);
		}
		catch(err) {
			errors.push(err.message);
		}

		return errors;
	}

	/**
	 * Interprets the metagames index stored on disk and loads it onto the memory. (good for reloading after manual edits)
	 */
	async loadMetagames() {
		this.#metagamesObject = {};
		this.#metagamesArray = [];
		this.#gametypes = {};
		const errors = [];

		// TODO: read these in parallel

		// We'll assume 1 subdir max, as does the extension partially
		const PATH_GROUPS = path.join(__dirname, "metagames");
		const GROUPS_DIRENT = await fs.promises.readdir(PATH_GROUPS, { withFileTypes: true })
		const GROUPS = GROUPS_DIRENT.filter((x) => x.isDirectory()).map((x) => x.name);
		for(const group of GROUPS) {
			this.#metagamesObject[group] = {};
			const PATH_METAS = path.join(PATH_GROUPS, group);
			const METAS = await fs.promises.readdir(PATH_METAS);
			for(const meta of METAS) {
				const PATH_TEXT = path.join(PATH_METAS, meta);
				const text = await fs.promises.readFile(PATH_TEXT, { encoding: "utf-8" });

				// Can have 2 props added: meta, deps
				this.#metagamesObject[group][meta] = { text };

				this.#metagamesArray.push(`${group}/${meta}`);
			}
		}

		const parentFind = /parent:\s*(.+?)\s*(?:;|$)/m;

		for(const group in this.#metagamesObject) {
			for(const meta in this.#metagamesObject[group]) {
				const self = this.#metagamesObject[group][meta];
				const parentName = parentFind.exec(self.text)?.[1];

				// This metagame has no parent; parse right away.
				if(!parentName) {
					self.meta = this.parseMeta(self.text, group);
					if(self.deps) self.deps.forEach((f) => f(self.meta));
					continue;
				}

				// This metagame has a parent, check that it exists.
				const [pGroup, pName] = parentName.split("/");
				if(!this.#metagamesObject[pGroup]?.[pName]?.text) {
					errors.push("");
					continue;
				}
				const parent = this.#metagamesObject[pGroup][pName];

				// This metagame's parent has already been parsed; parse right away.
				if(this.#metagamesObject[pGroup][pName].meta) {
					self.meta = this.parseMeta(self.text, group, parent.meta);
					if(self.deps) self.deps.forEach((f) => f(self.meta));
					continue;
				}

				// This metagame's parent has not been parsed yet. Give the parent a callback to parse this metagame when that is done.
				if(!parent.deps) parent.deps = [];
				parent.deps.push((ref) => {
					self.meta = parseMeta(self.text, group, ref);
					if(self.deps) self.deps.forEach((f) => f(self.meta));
				});
			}
		}

		for(const group in this.#metagamesObject) {
			for(const meta in this.#metagamesObject[group]) {
				if(!this.#metagamesObject[group][meta].meta) {
					errors.push("???");
					delete this.#metagamesObject[group][meta];
					continue;
				}

				/* for(const entry of this.#metagamesObject[group][meta].meta) {
					if(entry.header) continue;
					entry.value = toID(entry.value);
				} */

				this.#metagamesObject[group][meta] = this.#metagamesObject[group][meta].meta;
			}
		}

		// Misc files

		const PATH_GAMETYPES = path.join(PATH_GROUPS, "gametypes.txt");
		const TEXT_GAMETYPES = await fs.promises.readFile(PATH_GAMETYPES, { encoding: "utf-8" });
		for(const line of TEXT_GAMETYPES.split("\n").filter((x) => x)) {
			const [ gametype, formats ] = line.split(":");
			this.#gametypes[gametype] ??= [];
			this.#gametypes[gametype].push(...formats.split(","));
		}

		const PATH_BATTLEFACTORY = path.join(PATH_GROUPS, "factory-sets.json");
		const JSON_BATTLEFACTORY = require(PATH_BATTLEFACTORY);
		for(const format in JSON_BATTLEFACTORY) {
			this.#metagamesBF.push(format);
		}

		return errors;
	}

	/**
	 * @param {string} txt  - metagame to be interpreted.
	 * @param {string} group  - group to desplay before name in the top header. (there's no pretty way to handle this)
	 * @param {{}[]} [parent] - reference to interpreted parent metagame.
	 * @returns {{}[]} - interpreted metagame.
	 */
	parseMeta(txt, group, parent) {
		const metagame = structuredClone(parent) ?? [{}];
	
		// Capture the next line that has content.
		const lines = /^(.+)$/gm;
	
		// Match if first non-whitespace character is #
		const isComment = /^\s*#/;
	
		// Expect the mandatory data at the top - currently only the display name.
		while(true) {
			const line = lines.exec(txt)?.[1];
	
			// We've reached the end already. This means the file was a nothing burger.
			if(!line) return metagame;
	
			if(isComment.test(line)) continue;
	
			// For popup.
			metagame[0].name = line;
	
			// The first element of a metagame doubles up as a rules container and the top header.
			// Avoid displaying something like "2024 Nov 2024"
			metagame[0].value = `35 Pokes: ${line.includes(group)?"":group+" "} ${line}`;
			metagame[0].header = true;
	
			break;
		}
	
		// Everything else is optional and can be in any order.
	
		const isCode = /^\s*code:\s*(.*?)\s*$/i;
		const isRules = /^\s*rules;/i;
		const modPastGen = /;\s*generation:\s*(.+?)(?:$|[;\s])/i;
		const modFlipped = /;\s*flipped(?:$|[;\s])/i;
		const isHeader = /;\s*header\s*(?:;|$)/i;
		const isParent = /^\s*parent:/i;
		const dataValueBase = /^\s*(.*?)\s*(?:;|$)/;
		const dataValueChild = /^\s*([+-])\s*(.*?)\s*(?:;|$)/;
		const pkmnMoves = /;\s*moves:(.+?);/i;
		const pkmnMoveLoop = /([+-])\s*(.+?)\s*(?:,|$)/g;
	
		// split into a loop, like moves?
		const pkmnAbils = /;\s*abilities:(?:\s*1\s*:\s*(.*?)\s*(?:$|[,;]))?(?:(?<!;\s*)\s*2\s*:\s*(.*?)\s*(?:$|[,;]))?(?:(?<!;\s*)\s*3\s*:\s*(.*?)\s*(?:$|[,;]))?(?:(?<!;\s*)\s*4\s*:\s*(.*?)\s*(?:$|[,;]))?/i;
	
		while(true) {
			const line = lines.exec(txt)?.[1];
	
			// End of file
			if(!line) break;
	
			if(isComment.test(line)) continue;
			
			const code = isCode.exec(line)?.[1];
			if(code) {
				metagame[0].code = code;
				continue;
			}
	
			if(isRules.test(line)) {
				if(!metagame[0].mods) metagame[0].mods = [];
	
				const gen = modPastGen.exec(line)?.[1];
				if(gen) metagame[0].gen = gen;
	
				if(modFlipped.test(line)) metagame[0].mods.push("flipped");
	
				// Check other rules here.
	
				continue;
			}
	
			if(isHeader.test(line)) {
				// Always defined, but can be empty string.
				// We'll accept it for headers, reject it for pokemon names below.
				const value = dataValueBase.exec(line)[1];
				metagame.push({ value: value, header: true });
				continue;
			}
	
			const mon = {};
	
			if(parent) {
				const value = dataValueChild.exec(line);
				if(!value) {
					if(isParent.test(line)) continue;
					console.warn("35Pokes Background: Parsing child meta: Ignoring invalid line:", line);
					continue;
				}
				if(value[1] === "-") {
					const i = metagame.findLastIndex((mon) => toID(mon.value) === toID(value[2]));
					if(i >= 0) metagame.splice(i, 1);
					else console.warn("35Pokes Background: Parsing child meta: Could not remove nonexistent pokemon:", line);
					continue;
				}
				///
				//mon.value = value[2];
				const species = Dex.species.get(value[2]);
				const baseSpecies = Dex.species.get(species.baseSpecies);
				mon.value = baseSpecies.cosmeticFormes?.includes(species.name) ? baseSpecies.name : species.name;
			}
			else {
				const value = dataValueBase.exec(line)[1];
				if(value === "") {
					console.warn("35Pokes Background: Parsing base meta: Ignoring line with missing value:", line);
					continue;
				}
				///
				//mon.value = value;
				const species = Dex.species.get(value);
				const baseSpecies = Dex.species.get(species.baseSpecies);
				mon.value = baseSpecies.cosmeticFormes?.includes(species.name) ? baseSpecies.name : species.name;
			}
	
			const abilities = pkmnAbils.exec(line);
			if(abilities) {
				// Keep as is by default.
				// To delete ability slots, use "abilities:1:,2:,3:,4:;"
				// (whitespace between any of these is ok for this purpose.)
				mon.abilities = [true, true, true, true];
				if(typeof abilities[1] === "string") mon.abilities[0] = abilities[1];
				if(typeof abilities[2] === "string") mon.abilities[1] = abilities[2];
				if(typeof abilities[3] === "string") mon.abilities[2] = abilities[3];
				if(typeof abilities[4] === "string") mon.abilities[3] = abilities[4];
			}
	
			const moves = pkmnMoves.exec(line)?.[1];
			if(moves) {
				mon.moves = { add: [], ban: [] };
				while(true) {
					const move = pkmnMoveLoop.exec(moves);
					if(!move) break;
					// Use "-all, +move" to set learnset. This is handled in content_main.js
					if(move[1] === "+") mon.moves.add.push(move[2]);
					else mon.moves.ban.push(move[2]);
				}
			}
	
			metagame.push(mon);
		}
	
		return metagame;
	}

	getRandomBF() {
		const index = Math.floor(Math.random() * this.#metagamesBF.length);
		return this.#metagamesBF[index];
	}

	/**
	 * 35 Factory team generator
	 * 
	 * We had to:
	 * Rename pokemon-showdown/dist/data/random-battles/gen9/factory-sets.json
	 * Create our own json in its place
	 * Manually set generator.factoryTier
	 */
	generateTeam(format, pack) {
		if(!this.#metagamesBF.includes(format)) throw new Error("Invalid format");

		this.#generatorBF.factoryTier = format;
		const team = this.#generatorBF.getTeam();
		return pack ? Teams.pack(team) : team;
	}

	// Check battle, fill if missing props, then start.
	generateBattle(battle) {
		// Currently we can not create non-specific invites, so only proceed if provided usernames.
		// {side1:{usernames:["demirab1"]},side2:{usernames:["comeheavysleep"]}}
		if(!(battle?.side1?.usernames?.length > 0) || !(battle?.side2?.usernames?.length > 0)) {
			throw new Error("Missing battle data.");
		}

		battle.format ??= this.getRandomBF();

		const [ group, name ] = battle.format.split("/");
		const ref = this.#metagamesObject?.[group]?.[name]?.[0];

		battle.chalcode ??= ref?.code?.slice(10) ?? "gen9nationaldex35pokes @@@ +nduber, +ndag, +ndou, +nduubl, +nduu, +ndrubl, +ndru, +ndnfe, +ndlc";

		battle.message ??= `35 Factory Format: ${ref?.name ?? "idk"}`;

		battle.side1.team ??= this.generateTeam(battle.format, true);
		battle.side2.team ??= this.generateTeam(battle.format, true);

		return this.#psbots.battle(battle);
	}

};
