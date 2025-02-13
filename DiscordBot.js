"use strict";

{ // startup sanity checks
	let exit = false;
	console.log("Checking dependencies ...");
	try { console.log(`discord.js - ${require.resolve("discord.js")}`); }
	catch {
		exit = true;
		console.error("discord.js - failed");
		console.log("Hint: Run 'npm install' before launching the bot.");
	}
	// elo module goes here
	try { console.log(`sqlite - ${require.resolve("node:sqlite")}`); }
	catch {
		exit = true;
		console.error("sqlite - failed");
		console.log("Hint: Run 'npm start' instead of 'node .' or 'node bot.js'");
	}
	if(exit) process.exit(1);
}

const path = require("node:path");
const { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const MetagameHelper = require("./MetagameHelper.js");

const configPath = path.join(__dirname, "config.json");
const cfg = require(configPath);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST().setToken(cfg.token);

const mh = new MetagameHelper();
const INIT_MH = mh.init();

const DISCORD_MAX_OPTIONS = 25;

// SLASH COMMANDS

client.on(Events.InteractionCreate, (interaction) => {
	if(interaction.isAutocomplete()) { // these are only suggestions!
		const input = interaction.options.getFocused();
		const regex = new RegExp(input, "i");
		const matches = mh.memoryArray
		.filter((x) => regex.test(x))
		.slice(0, DISCORD_MAX_OPTIONS)
		.map((x) => ({ name: x, value: x }));
		return interaction.respond(matches);
	}

	if(!interaction.isChatInputCommand()) return;

	// handle global cooldowns here

	switch(interaction.commandName) {

		case "help": {
			return interaction.reply(".w. henlo");
		}

		case "refresh": {
			return interaction.deferReply()
			.then(() => {
				return mh.fetchMetagames();
			})
			.then((errs) => {
				if(errs.length) throw errs;
				return mh.loadMetagames();
			})
			.then((errs) => {
				if(errs.length) throw errs;
				return interaction.followUp("Success! Try /memory");
			})
			.catch((errs) => {
				return interaction.followUp(`Errors: ${JSON.stringify(errs)}`);
			});
		}

		case "memory": {
			let buf = "";
			buf += "List of loaded metagames:\n";
			buf += mh.memoryArray.join("\n") || "None!";
			return interaction.reply(buf);
		}

		case "meta-to-chalcode": {
			const [ group, meta ] = interaction.options.getString("metagame").split("/");
			
			const target = mh.memoryObject[group]?.[meta];
			if(!target) return interaction.reply("?");

			const list = target.filter((x) => !x.header).map((x) => x.value);
			const result = [];
			const errors = [];

			for(const mon of list) {
				const tcc = mh.toChalCode(mon);
				if(tcc) result.push(tcc);
				else errors.push(`Invalid species: ${tcc}`);
			}

			let buf = "";
			buf += `=== Normalized pokemon for the chal code of ${group}/${meta} ===\n\`+`;
			buf += result.join(", +");
			buf += `\`\n=== Errors ===\n${errors.length ? errors.join("\n") : "None!"}`;

			return interaction.reply(buf);
		}

		case "list-to-chalcode": {
			const input = interaction.options.getString("list");
			if(!input) {
				return interaction.reply("?");
			}
			// Newlines are converted to spaces in slash commands.
			const list = input.split(" ");
			const result = [];
			const errors = [];

			for(const mon of list) {
				const tcc = mh.toChalCode(mon);
				if(tcc) result.push(tcc);
				else errors.push(`Invalid species: ${mon}`);
			}

			let buf = "";
			buf += `=== Normalized pokemon for chal codes ===\n\`+`;
			buf += result.join(", +");
			buf += `\`\n=== Errors ===\n${errors.length ? errors.join("\n") : "None!"}`;

			return interaction.reply(buf);
		}

		case "validate": {
			const urlStr = interaction.options.getString("url"); // make mandatory
			return interaction.deferReply()
			.then(() => {
				// sanity checks for url here
				const url = new URL(urlStr);
				const errors = [];

				// TODO: define this in mh and allow root to edit
				const trustedHosts = [
					"replay.pokemonshowdown.com"
				];

				if(url.protocol !== "https:") {
					errors.push("URL wrong protocol");
				}

				if(!trustedHosts.includes(url.hostname)) {
					errors.push("URL host name not trusted");
				}

				if(!url.pathname.endsWith(".log")) {
					url.pathname += ".log";
				}

				if(errors.length) throw errors;

				return mh.validate(url);
			})
			.then((out) => {
				if(out.errors.length) throw out.errors;

				const matches = Array.from(out.formats.entries())
				.filter((x) => x[1].length <= 4)
				.sort((a, b) => a[1].length - b[1].length);

				let buf = "";
				buf += `Date: <t:${out.timestamp}:f>\n`;
				buf += `Winner: ${out.battle[out.winner].player}\n`;
				for(const side of out.battle) {
					buf += `Side ${side.player} preview: ${side.preview?.join(", ") || "None"}\n`;
					buf += `Side ${side.player} reveals: ${Array.from(side.reveals ?? []).join(", ") || "None"}\n`;
					buf += `Side ${side.player} result: ${side.pokemon?.join(", ") || "None"}\n`;
				}
				buf += "Format prediction:";
				for(const format of matches) {
					buf += `\n${format[0]}: `;
					if(format[1].length) {
						buf += `Mismatches: ${format[1].join(", ")}`;
					}
					else {
						buf += "Perfect match!";
					}
				}

				return interaction.followUp(buf);
			})
			.catch((errs) => {
				if(!Array.isArray(errs)) {
					return interaction.followUp(`Error: ${errs.message}`);
				}
				return interaction.followUp(`Errors: ${JSON.stringify(errs)}`);
			});
		}

		case "deploy": {
			if(!cfg.admins.includes(interaction.user.username)) {
				return interaction.reply("Only admins are allowed to deploy commands.");
			}

			const commands = [

				new SlashCommandBuilder()
					.setName("help")
					.setDescription("commands help"),

				new SlashCommandBuilder()
					.setName("refresh")
					.setDescription("Fetch and load the metagames index."),

				new SlashCommandBuilder()
					.setName("memory")
					.setDescription("debug - shows loaded metagames"),

				new SlashCommandBuilder()
					.setName("meta-to-chalcode")
					.setDescription("meta-to-chalcode")
					.addStringOption((o) => o
						.setName("metagame")
						.setDescription("metagame")
						.setRequired(true)
						.setAutocomplete(true)),

				new SlashCommandBuilder()
					.setName("list-to-chalcode")
					.setDescription("list-to-chalcode")
					.addStringOption((o) => o
						.setName("list")
						.setDescription("list")
						.setRequired(true)),

				new SlashCommandBuilder()
					.setName("validate")
					.setDescription("Parse a replay into useful information.")
					.addStringOption((o) => o
						.setName("url")
						.setDescription("Replay URL")
						.setRequired(true)),

				new SlashCommandBuilder()
					.setName("deploy")
					.setDescription("Deploy bot commands."),

				/* new SlashCommandBuilder()
					.setName("test")
					.setDescription("test"), */

			].map((x) => x.toJSON());

			return interaction.deferReply()
			.then((response) => {
				return rest.put(
					Routes.applicationCommands(cfg.clientId),
					{ body: commands }
				);
			})
			.then((data) => {
				console.log(data);
				return interaction.followUp("Success! Reload your Discord tab.");
			})
			.catch((err) => {
				console.error(err);
				return interaction.followUp("Fail! Tell the dev to check console.");
			});
		}

	}

	return interaction.reply("Unknown command! Try /deploy");
});

// LAUNCH

client.once(Events.ClientReady, (client) => {
	console.log(`Ready! Logged in as ${client.user.tag}`);
});

Promise.all([
	INIT_MH,
])
.then((errors) => {
	if(errors.some((err) => err.length)) throw errors;
	return client.login(cfg.token);
})
.then(() => {
	console.log("Successfully launched!");
})
.catch((errors) => {
	console.log("Failed to launch due to errors:");
	console.dir(errors, { depth: null });
});
