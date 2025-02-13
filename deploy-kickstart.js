const path = require("node:path");
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const configPath = path.join(__dirname, "config.json");
const cfg = require(configPath);

const rest = new REST().setToken(cfg.token);

const commands = [
	new SlashCommandBuilder()
		.setName("deploy")
		.setDescription("Deploy bot commands (kickstart).")
		.toJSON(),
]

rest.put(
	Routes.applicationCommands(cfg.clientId),
	{ body: commands },
)
.then((data) => {
	console.log("Success:");
	console.log(data);
})
.catch((err) => {
	console.error(err);
});
