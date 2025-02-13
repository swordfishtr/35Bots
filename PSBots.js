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
		for(const bot of this.bots) {
			bot.ws = new WebSocket(this.getEntry());
			bot.ws.bot = bot;
			bot.ws.class = this;
			bot.ws.addEventListener(E_MESSAGE, L_CONNECT, { signal: this.signal });
			bot.ws.addEventListener(E_ERROR, L_ERROR, { signal: this.signal });
			bot.ws.addEventListener(E_CLOSE, L_CLOSE, { once: true });
		}
	}
	
	// USE PACKED TEAMS
	battle(battle) {
		// resolve into the battle url string since idk what else would be useful.
		// maybe another promise with replay url.
		return new Promise((res, rej) => {
			if(
				typeof battle !== "object"
				|| !battle.message
				|| !battle.chalcode

				|| !battle.side1
				|| !battle.side1.team
				|| !battle.side1.usernames
				|| battle.side1.confirmed

				|| !battle.side2
				|| !battle.side2.team
				|| !battle.side2.usernames
				|| battle.side2.confirmed
			) {
				rej("Invalid data in argument.");
				ctrl.abort();
				return;
			}

			// Notes:
			// EventTarget can only have one event listener per function.
			// EventTarget event listeners only get a message for their arguments.
			// Bound functions can't remove their associated event listeners.
	
			const ctrl = new AbortController();
			const bound = L_BATTLE1.bind(this.bots[0].ws, res, rej, ctrl, battle);
			this.bots[0].ws.addEventListener(E_MESSAGE, bound, { signal: ctrl.signal });
	
			for(const user of battle.side1.usernames) {
				const msgraw = msgToRaw(`|/cmd userdetails ${user}`);
				this.bots[0].ws.send(msgraw);
			}
			for(const user of battle.side2.usernames) {
				const msgraw = msgToRaw(`|/cmd userdetails ${user}`);
				this.bots[0].ws.send(msgraw);
			}

			// TODO: use numbers here, convert to error messages in bot.js

			setTimeout(() => {
				rej("No response from showdown.");
				ctrl.abort();
			}, 30 * 1000);
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

	test() {

	}

};

function msgToRaw(msg) {
	if(typeof msg !== "string") throw new Error("Message must be a string.");
	return `["${msg ?? ""}"]`;
}

/**
 * Sets up a unique event listener on the websocket and applies incoming messages on the predicate. The listener is removed after this is settled.
 * 
 * Predicate return values:
 * true => resolve with message.
 * false => reject with message.
 * else => keep listening.
 * 
 * Usage:
 * Send ws commands -> await this -> repeat.
 * 
 * @param {WebSocket} ws - Don't confuse which bots websocket you're using.
 * @param {(msgraw: string) => boolean | any} predicate - Settle condition.
 * @param {number} timer - reject after this amount of time in seconds.
 */
function awaitws(ws, timer, predicate) {
	return new Promise((res, rej) => {
		const ctrl = new AbortController();
		ws.addEventListener(E_MESSAGE, (msgraw) => {
			if(predicate(msgraw) === false) {
				rej(msgraw);
				ctrl.abort();
				return;
			}
			if(predicate(msgraw) === true) {
				res(msgraw);
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

// Await challstr.
function L_CONNECT(msgraw) {
	const msg = msgraw.data.slice(3, -2);

	const data = msg.split("|");
	if(data[1] !== "challstr") return;

	return fetch("https://play.pokemonshowdown.com/~~showdown/action.php", {
		method: 'POST',
		headers: { "Content-Type": "application/x-www-form-urlencoded; encoding=UTF-8" },
		body: qs.stringify({
			act: "login",
			name: this.bot.name,
			pass: this.bot.pass,
			challstr: msg.slice(10)
		})
	})
	.then((res) => {
		if(!res.ok) throw new Error(`Could not connect ${this.bot.name}.`);
		return res.text();
	})
	.then((res) => JSON.parse(res.slice(1)))
	.then((res) => {
		if(
			!res.actionsuccess
			|| !res.curuser.loggedin
			|| res.assertion.startsWith(";;")
		) {
			throw new Error(`Could not login ${this.bot.name}: ${res.assertion}`);
		}

		this.removeEventListener("message", L_CONNECT);
		this.addEventListener("message", L_IDLE, { signal: this.class.signal });

		this.send(`["|/trn ${this.bot.name},0,${res.assertion}"]`);
	})
	.catch((err) => {
		console.error(err);
	});
}

function L_IDLE(msgraw) {
	console.log("");
	console.log(this.bot.name + ":");
	console.log(msgraw.data);
}


// Check player availability.
// `this` is likely class.bots[0].ws
function L_BATTLE1(res, rej, controller, battle, msgraw) {
	const msg = msgraw.data.slice(3, -2);

	const data = msg.split("|");
	if(data[1] !== "queryresponse" || data[2] !== "userdetails") return;

	//console.log(`${this.bot.name}: this log should not appear more than once in a row.`);

	/**
	 * battle is
	 * {
	 * message: string,
	 * chalcode: string,
	 * side1: { team: string, usernames: string[] },
	 * side2: { team: string, usernames: string[] },
	 * }
	 */

	const details = JSON.parse(data[3].replaceAll("\\", ""));

	// Should never happen.
	if(!details) {
		rej("Unregistered username in queue.");
		controller.abort();
		return;
	}

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

	// Not relevant to this battle.
	if(!foundUser) return;

	if(!details.rooms) {
		rej(`User is offline: ${details.name}`);
		controller.abort();
		return;
	}

	foundSide.confirmed = foundUser;

	if(!battle.side1.confirmed || !battle.side2.confirmed) return;

	// All set! Starting battle.

	// TODO: INSTEAD OF PROCEEDING, ADD BATTLE TO QUEUE

	controller.abort();

	const bots = this.class.bots;

	const msgraw0 = msgToRaw(`|/utm ${battle.side1.team}`);
	const msgraw1 = msgToRaw(`|/utm ${battle.side2.team}`);
	bots[0].ws.send(msgraw0);
	bots[1].ws.send(msgraw1);

	const ctrl = new AbortController();
	const bound = L_BATTLE2.bind(bots[1].ws, res, rej, ctrl, battle);
	bots[1].ws.addEventListener(E_MESSAGE, bound, { signal: ctrl.signal });

	const msgraw2 = msgToRaw(`|/challenge ${bots[1].name}, ${battle.chalcode}`);
	bots[0].ws.send(msgraw2);

	setTimeout(() => {
		rej("No response from showdown.");
		ctrl.abort();
	}, 30 * 1000);
	
}

// Await challenge.
// `this` is likely class.bots[1].ws
function L_BATTLE2(res, rej, controller, battle, msgraw) {
	const msg = msgraw.data.slice(3, -2);

	const data = msg.split("|");
	if(
		data[1] !== "pm"
		|| data[2].slice(1) !== this.class.bots[0].name
		|| data[3].slice(1) !== this.class.bots[1].name
		|| !data[4].startsWith("/challenge ")
	) {
		return;
	}

	controller.abort();

	const bots = this.class.bots;

	const msgraw0 = msgToRaw(`|/accept ${this.class.bots[0].name}`);
	bots[1].ws.send(msgraw0);

	const ctrl = new AbortController();
	const bound = L_BATTLE3.bind(bots[0].ws, res, rej, ctrl, battle);
	bots[0].ws.addEventListener(E_MESSAGE, bound, { signal: ctrl.signal });

	setTimeout(() => {
		rej("No response from showdown.");
		ctrl.abort();
	}, 30 * 1000);
}

// Await battle start.
// `this` is likely class.bots[0].ws
function L_BATTLE3(res, rej, controller, battle, msgraw) {
	const msg = msgraw.data.slice(3, -2);

	const [ room, data_ ] = msg.split("\\n");

	if(!data_) return;

	const data = data_.split("|");

	if(data[1] !== "init" || data[2] !== "battle") return;

	controller.abort();
	res(`https://play.pokemonshowdown.com/${room.slice(1)}`);

	console.log(`Started battle: https://play.pokemonshowdown.com/${room.slice(1)}`);

	const msgraw0 = msgToRaw(`${room.slice(1)}|/timer on`);
	const msgraw1 = msgToRaw(`${room.slice(1)}|${battle.message}`);

	const bots = this.class.bots;
	bots[0].ws.send(msgraw0);
	bots[1].ws.send(msgraw0);
	bots[0].ws.send(msgraw1);
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
