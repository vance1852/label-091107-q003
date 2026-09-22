# 救援物资流转服务

震区道路时断时通场景下的物资调拨后端：批次库存（保质期 / 位置 / 责任人）、
调拨全流程（建单 → 分批装车 → 途中交接 → 到站签收 → 异常退回）、
离线交接补录与崩溃恢复。

项目使用 Node.js 20 以上版本，不依赖外部软件。运行 `npm test` 执行测试，
`npm start` 启动服务（默认端口 3000，可用 `PORT` 覆盖；数据目录默认 `./data`，
可用 `DATA_DIR` 覆盖）。`GET /health` 查看进程状态。

## 约定

- 数量一律以最小发放单位记录（正整数）。
- 时间采用带时区的 ISO 8601 格式（服务端统一落 UTC）。
- 批次号（`B-`）、调拨单号（`T-`）、发运单号（`S-`）、交接凭证号（`V-`）、
  异常号（`X-`）在各自范围内唯一，重启后不重复。
- 错误响应统一为 `{ "error": "...", "code": "..." }`：400 参数错误、
  404 不存在、409 业务规则冲突（库存不足 / 已过期 / 凭证不符 / 状态不允许）。

## 持久化与崩溃恢复

所有状态变更先追加写入 `data/journal.jsonl`（一批事件一次写入并 fsync），
再应用到内存状态。进程在交接中途退出时，重启会重放日志完整恢复未完成的
流转；崩溃造成的末尾半截记录会被安全截断，已提交的事件不受影响。

## 批次库存

### `POST /batches`

登记批次，保留保质期、位置与责任人：

```json
{ "materialType": "药品", "quantity": 500, "expiryDate": "2026-12-31T00:00:00.000Z",
  "location": "省级仓库", "keeper": "仓管员甲" }
```

`expiryDate` 可空（帐篷等无保质期物资）。返回 201 与批次对象。

### `GET /batches?location=&materialType=&includeExpired=`

批次库存列表（默认不列出已过期批次）。`GET /batches/:id` 返回单批次在各位置的
现存量、预留量、责任人及在途明细；`GET /batches/:id/journey` 返回该批次相关的
全部事件，可还原其流转轨迹。

## 调拨单

### `POST /transfer-orders`

建单即分配库存，按 FEFO（先到期先出）自动选择批次，临期药品优先发出；
库存不足或批次已过期时返回 409。也可用 `lines[].batchId` 指定批次。

```json
{ "origin": "省级仓库", "destination": "震中安置点", "createdBy": "调度员",
  "lines": [ { "materialType": "饮用水", "quantity": 100 } ] }
```

订单状态：`open`（未发）→ `shipping`（部分发运）→ `fulfilled`（全部发运）；
`closed` 表示已关闭（取消未发部分）。

### `PATCH /transfer-orders/:id`

调整明细数量。**部分发运之后只允许调整未发数量**：新数量不得小于该行的
已发数量。调减释放预留库存，调增按 FEFO 追加分配（库存不足返回 409）。

```json
{ "lines": [ { "lineId": "L1", "quantity": 70 } ] }
```

### `POST /transfer-orders/:id/cancel`

关闭调拨单，释放全部未发预留；已发运部分的发运记录保留。

### `GET /transfer-orders` / `GET /transfer-orders/:id` / `GET /transfer-orders/:id/journey`

列表（可按 `status`、`destination` 过滤）、详情，以及整段旅程还原：
时间线（建单 / 调整 / 装车 / 交接 / 签收 / 退回 / 异常）加各发运单的责任链。

## 发运与责任链

每次装车生成发运单和首段凭证（序号 1）。之后每一步交接都产生新凭证，
**下一节点只有持前一节点产生的凭证才可接货**；旧凭证立即失效。

### `POST /transfer-orders/:id/shipments`

分批装车：`{ "carrier": "司机老王", "lines": [ { "lineId": "L1", "quantity": 60 } ] }`。
装车数量不得超过该行未发数量。货物出库，状态 `in_transit`。

### `POST /shipments/:id/handover`

途中交接：`{ "voucher": "V-000001", "toKeeper": "中转站负责人", "node": "中途转运站" }`。
校验当前凭证，生成下一段凭证，责任转移给新的接货人。

### `POST /shipments/:id/receive`

到站签收：`{ "voucher": "...", "toKeeper": "安置点负责人", "node": "震中安置点" }`。
`node` 必须是目的地；签收后货物计入目的地库存，签收人成为该处责任人。

### `POST /shipments/:id/return` → `POST /shipments/:id/return-receive`

异常退回：途中凭当前凭证登记退回（`reason` 必填），发运单转为 `returning`；
物资回到起点后由仓管员接收（`node` 必须是起点），`restock: true` 重新入库，
`false` 报废。退回与报废都会进入异常清单。

### `POST /shipments/:id/offline-sync`

现场网络恢复后一次提交多条带序号的离线交接：

```json
{ "records": [
  { "seq": 2, "type": "handover", "voucher": "OFF-A1", "previousVoucher": "V-000001",
    "toKeeper": "中转站负责人", "node": "中途转运站", "at": "2026-09-22T10:00:00.000Z" },
  { "seq": 3, "type": "receive", "voucher": "OFF-A2", "previousVoucher": "OFF-A1",
    "toKeeper": "安置点负责人", "node": "震中安置点", "at": "2026-09-22T15:00:00.000Z" }
] }
```

逐条处理并返回 `{ applied, duplicates, rejected, head, status }`：

- **可衔接**（序号接续、`previousVoucher` 指向当前链顶、凭证全局未用、
  类型与当前状态相容）→ 接受，责任链沿原链延伸；
- **重复**（与已确认记录内容一致，如网络重试）→ 幂等跳过；
- **冲突**（同序号不同内容）→ 拒绝并记入异常清单，原责任链不受污染；
- **断链 / 凭证复用 / 节点不符** → 拒绝并说明原因。

`type` 支持 `handover` / `receive` / `return` / `return_receive`，
即离线期间也可以完成签收与退回。

## 报表

- `GET /reports/inventory` — 批次库存：各位置现存 / 预留 / 可用、在途数量。
- `GET /reports/destinations` — 目的地汇总：计划、已发、已签收、在途、退回中、已退回。
- `GET /reports/exceptions?withinDays=7` — 异常清单：已过期库存、临期批次
  （含位置与责任人）、异常退回、报废、离线冲突。

仓管员结合批次库存、目的地汇总、异常清单与旅程接口，即可还原任何一单
物资从建单到签收（或退回）的整段旅程。
