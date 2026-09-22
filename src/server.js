import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`救援物资流转服务已启动，端口 ${port}`);
  });
  const shutdown = async () => {
    app.close();
    await app.service.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
