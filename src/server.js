import { pathToFileURL } from "node:url";
import { createDefaultApp } from "./http.js";

export const app = createDefaultApp();

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`relief-supply-service 已启动，监听端口 ${port}（数据目录 ${process.env.DATA_DIR ?? "./data"}）`);
  });
}
