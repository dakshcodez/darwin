import { loadConfig } from "../orchestrator/config.js";
import { destroyAllOurs, makeClient, quota } from "../orchestrator/createos.js";

const client = makeClient(loadConfig({ requireDb: false }));
console.log("before:", await quota(client));
const { destroyed, networks } = await destroyAllOurs(client);
console.log("destroyed sandboxes:", destroyed.length ? destroyed.join(", ") : "(none)");
console.log("deleted networks:", networks.length ? networks.join(", ") : "(none)");
console.log("after:", await quota(client));
