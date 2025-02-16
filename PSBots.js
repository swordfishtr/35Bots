/**
 * PSBots.js
 * 
 * This is an interface for a group of Pokemon Showdown bots, usually 2 of them.
 * They can start battles with provided teams and return invite links for each side.
 * The end result is a matchmaking system outside of PS, for a format to be played on PS.
 * 
 * @author demi
 */

"use strict";
const qs = require('querystring');

const E_CLOSE = "close";
const E_ERROR = "error";
const E_MESSAGE = "message";
const E_OPEN = "open";

module.exports = class {

	/** @type {{ name: string, pass: string, ws: WebSocket }[]} */
	bots = null;

	/** @type {AbortController} */
	#abort = null;

	get signal() {
		return this.#abort.signal;
	}

	constructor(auth) {
		if(
			!Array.isArray(auth)
			|| auth.some((x) => !x || !x.name || !x.pass || x.ws)
		) {
			throw new Error("Invalid authentication data.");
		}

		this.bots = auth;
		this.#abort = new AbortController();
	}

	shutdown(reason) {
		if(this.bots.some((x) => !x.ws) || this.#abort.signal.aborted) {
			console.log("Shutdown attempted while not connected.");
			return;
		}
		for(const { ws } of this.bots) {
			ws.close();
		}
		this.#abort.abort(reason);
	}

	connect() {
		const connections = [];
		for(const bot of this.bots) {
			bot.ws = new WebSocket(this.getEntry());
			bot.ws.bot = bot;
			bot.ws.class = this;
			bot.ws.addEventListener(E_ERROR, L_ERROR, { signal: this.signal });
			bot.ws.addEventListener(E_CLOSE, L_CLOSE, { once: true });
			connections.push(awaitws(bot.ws, 30, (msgraw) => {
				const msg = msgraw.slice(3, -2);

				const data = msg.split("|");
				if(data[1] !== "challstr") return;
				return true;
			})
			.then((msgraw) => fetch("https://play.pokemonshowdown.com/~~showdown/action.php", {
				method: 'POST',
				headers: { "Content-Type": "application/x-www-form-urlencoded; encoding=UTF-8" },
				body: qs.stringify({
					act: "login",
					name: bot.name,
					pass: bot.pass,
					challstr: msgraw.slice(13,-2)
				})
			}))
			.then((res) => {
				if(!res.ok) throw new Error(`Could not connect ${bot.name}.`);
				return res.text();
			})
			.then((res) => JSON.parse(res.slice(1)))
			.then((res) => {
				if(
					!res.actionsuccess
					|| !res.curuser.loggedin
					|| res.assertion.startsWith(";;")
				) {
					throw new Error(`Could not login ${bot.name}: ${res.assertion}`);
				}

				bot.ws.addEventListener("message", L_IDLE, { signal: this.signal });

				bot.ws.send(`["|/trn ${bot.name},0,${res.assertion}"]`);
			})
			.catch((err) => {
				this.shutdown();
				throw err;
			}));
		}
		return Promise.all(connections)
		.then(() => "=== ALL CONNECTED ===");
	}
	
	// USE PACKED TEAMS
	battle(battle) {
		// resolve into the battle url string since idk what else would be useful.
		// maybe another promise with replay url.

		// Input type checks.
		if(
			typeof battle !== "object"
			|| typeof battle.message !== "string"
			|| typeof battle.chalcode !== "string"

			|| typeof battle.side1 !== "object"
			|| typeof battle.side1.team !== "string"
			|| !Array.isArray(battle.side1.usernames)
			|| battle.side1.confirmed

			|| typeof battle.side2 !== "object"
			|| typeof battle.side2.team !== "string"
			|| !Array.isArray(battle.side2.usernames)
			|| battle.side2.confirmed
		) {
			throw new Error("Invalid data in argument.");
		}

		// Requesting player info for sanity checks.
		for(const user of battle.side1.usernames) {
			const msgraw = this.msgToRaw(`|/cmd userdetails ${user}`);
			this.bots[0].ws.send(msgraw);
		}
		for(const user of battle.side2.usernames) {
			const msgraw = this.msgToRaw(`|/cmd userdetails ${user}`);
			this.bots[0].ws.send(msgraw);
		}

		// Awaiting player info.
		return awaitws(this.bots[0].ws, 30, (msgraw) => {
			const msg = msgraw.slice(3, -2);

			const data = msg.split("|");
			if(data[1] !== "queryresponse" || data[2] !== "userdetails") return;

			//console.log(`${this.bot.name}: this log should not appear more than once in a row.`);

			const details = JSON.parse(data[3].replaceAll("\\", ""));

			if(!details) return "Unregistered username in queue.";

			let foundUser = battle.side1.usernames.find((x) => x === details.name);
			let foundSide;

			if(foundUser) {
				foundSide = battle.side1;
			}
			else {
				foundUser = battle.side2.usernames.find((x) => x === details.name);
				if(foundUser) {
					foundSide = battle.side2;
				}
			}

			if(!foundUser) return;

			if(!details.rooms) return `User is offline: ${details.name}`;

			foundSide.confirmed = foundUser;

			if(!battle.side1.confirmed || !battle.side2.confirmed) return;

			return true;
		})
		.then(() => {
			// Sending challenge.
			const msgraw0 = this.msgToRaw(`|/utm ${battle.side1.team}`);
			const msgraw1 = this.msgToRaw(`|/utm ${battle.side2.team}`);
			this.bots[0].ws.send(msgraw0);
			this.bots[1].ws.send(msgraw1);

			const msgraw2 = this.msgToRaw(`|/challenge ${this.bots[1].name}, ${battle.chalcode}`);
			this.bots[0].ws.send(msgraw2);

			// Awaiting challenge.
			return awaitws(this.bots[1].ws, 30, (msgraw) => {
				const msg = msgraw.slice(3, -2);

				const data = msg.split("|");
				if(
					data[1] !== "pm"
					|| data[2].slice(1) !== this.bots[0].name
					|| data[3].slice(1) !== this.bots[1].name
					|| !data[4].startsWith("/challenge ")
				) {
					return;
				}

				return true;
			});
		})
		.then(() => {
			// Accepting challenge
			const msgraw0 = this.msgToRaw(`|/accept ${this.bots[0].name}`);
			this.bots[1].ws.send(msgraw0);

			// Awaiting battle room.
			return awaitws(this.bots[0].ws, 30, (msgraw) => {
				const msg = msgraw.slice(3, -2);
				const [ room, data_ ] = msg.split("\\n");

				if(!data_) return;

				const data = data_.split("|");

				if(data[1] !== "init" || data[2] !== "battle") return;

				return true;
			});
		})
		.then((msgraw) => {
			// Battle on-start actions.
			const msg = msgraw.slice(3, -2);
			const [ room, data_ ] = msg.split("\\n");

			const msgraw0 = this.msgToRaw(`${room.slice(1)}|${battle.message}`);
			const msgraw1 = this.msgToRaw(`${room.slice(1)}|/timer on`);
			const msgraw2 = this.msgToRaw(`${room.slice(1)}|/leavebattle`);
			const msgraw3 = this.msgToRaw(`${room.slice(1)}|/addplayer ${battle.side1.confirmed}, p1`);
			const msgraw4 = this.msgToRaw(`${room.slice(1)}|/addplayer ${battle.side2.confirmed}, p2`);
			const msgraw5 = this.msgToRaw(`|/noreply /leave ${room.slice(1)}`);

			this.bots[0].ws.send(msgraw0);
			this.bots[0].ws.send(msgraw1);
			this.bots[1].ws.send(msgraw1);
			this.bots[0].ws.send(msgraw2);
			this.bots[1].ws.send(msgraw2);
			this.bots[0].ws.send(msgraw3);
			this.bots[1].ws.send(msgraw4);
			this.bots[1].ws.send(msgraw5);

			
			// Return the battle URL and a promise for the corresponding replay.
			return {
				room: `https://play.pokemonshowdown.com/${room.slice(1)}`,
				replay: awaitws(this.bots[0].ws, 60 * 60, (msgraw) => {
					// Awaiting battle end.
					const msg = msgraw.slice(3, -2);
					const data = msg.split("\\n").pop()?.split("|")?.[1];
					if(data !== "win") return;
					return true;
				})
				.then(() => {
					const msgraw0 = this.msgToRaw(`${room.slice(1)}|/savereplay`);
					this.bots[0].ws.send(msgraw0);
					return awaitws(this.bots[0].ws, 60, (msgraw) => {
						const msg = msgraw.slice(3, -2);
						const test = new RegExp(`^|popup||html|<p>Your replay has been uploaded!.+?${room.slice(1)}`);
						if(!test.test(msg)) return;
						return true;
					});
				})
				.then((msgraw) => {
					this.bots[0].ws.send(msgraw5);
					return /href="(.+?)"/.exec(msgraw)?.[1] ?? "this should not have happened";
				})
			};
		});
	}

	getEntry() {
		const chars = "abcdefghijklmnopqrstuvwxyz0123456789_";

		let r1 = "";
		while(r1.length < 8) {
			const i = Math.floor(Math.random() * chars.length);
			r1 += chars[i];
		}

		const r2 = Math.floor(Math.random() * 900) + 100;

		return `wss://sim3.psim.us/showdown/${r1}/${r2}/websocket`;
	}

	msgToRaw(msg) {
		if(typeof msg !== "string") throw new Error("Message must be a string.");
		return `["${msg ?? ""}"]`;
	}

	test() {

	}

};

/**
 * Sets up a unique event listener on the websocket and applies incoming messages on the predicate. The listener is removed after this is settled.
 * 
 * Predicate return values:
 * true => resolve with msgraw
 * string => reject with { reason, msgraw }
 * else => keep listening.
 * 
 * Usage:
 * Send ws commands -> await this -> check for reason in output -> repeat.
 * 
 * @param {WebSocket} ws - Don't confuse which bots websocket you're using.
 * @param {(msgraw: string) => boolean | any} predicate - Settle condition.
 * @param {number} timer - reject after this amount of time in seconds.
 * @returns {Promise<string>}
 */
function awaitws(ws, timer, predicate) {
	// Notes:
	// EventTarget can only have one event listener per function.
	// EventTarget event listeners get a message for their arguments and nothing else.
	// Bound functions can't remove their associated event listeners.
	return new Promise((res, rej) => {
		const ctrl = new AbortController();
		ws.addEventListener(E_MESSAGE, (msgraw) => {
			const reason = predicate(msgraw.data);
			if(reason === true) {
				res(msgraw.data);
				ctrl.abort();
				return;
			}
			if(typeof reason === "string") {
				rej({ reason, msgraw: msgraw.data });
				ctrl.abort();
				return;
			}
		}, { signal: ctrl.signal });
		setTimeout(() => {
			rej("Timed out (awaitws).");
			ctrl.abort();
		}, timer * 1000);
	});
}

// Listener functions (`this` is WebSocket)

function L_CLOSE() {
	console.log(`=== SHUTDOWN ${this.bot.name} ===`);
}

function L_ERROR(err) {
	console.error(err);
	this.class.shutdown();
}

function L_IDLE(msgraw) {
	console.log("");
	console.log(this.bot.name + ":");
	console.log(msgraw.data);
}

/**
 * |/challenge demirab3, gen9nfe
 * |/reject comeheavysleep
 * |/accept comeheavysleep
 * battle-gen9nfe-2297696495|/leavebattle
 * |/noreply /leave battle-gen9nfe-2297696495
 * battle-gen9nfe-2297696495|/addplayer demirab1, p2
 * battle-gen9nfe-2297696495|/timer on
 * 
 * |/cmd userdetails jhjhj
 * a[">battle-gen9nationaldex35pokes-2297742922\n|init|battle\n|title|demirab3 vs. demirab1\n|j|☆demirab3\n"]
 * 
 * |/friends viewnotifs
 * 
 * |pm| comeheavysleep| demirab1|/challenge gen9nfe||You're invited to join a battle (with )||
 */

/**
 * << >battle-gen9randombattle-2301526504
|
|t:|1739661832
|move|p1a: Iron Jugulis|Dark Pulse|p2a: Meganium
|-crit|p2a: Meganium
|-damage|p2a: Meganium|0 fnt
|faint|p2a: Meganium
|
|win|comeheavysleep
 */

/**
 * >> battle-gen9randombattle-2301526504|/savereplay
 * 
 * << |popup||html|<p>Your replay has been uploaded! It's available at:</p><p> <a class="no-panel-intercept" href="https://replay.pokemonshowdown.com/gen9randombattle-2301526504" target="_blank">https://replay.pokemonshowdown.com/gen9randombattle-2301526504</a> <copytext value="https://replay.pokemonshowdown.com/gen9randombattle-2301526504">Copy</copytext>
 */
