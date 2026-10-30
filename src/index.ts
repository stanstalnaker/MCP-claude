import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MemoryStore, RedisStore, type Store } from "./store.js";

const config = loadConfig();

let store: Store;
if (config.redisUrl) {
  store = await RedisStore.connect(config.redisUrl);
} else {
  console.warn("REDIS_URL is not set: sign-ins are kept in memory and lost on restart.");
  store = new MemoryStore();
}

createApp(config, store).listen(config.port, () => {
  console.log(`Hub Culture MCP server on :${config.port}, public URL ${new URL("/mcp", config.publicUrl).href}`);
});
