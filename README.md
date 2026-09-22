# 救援物资流转服务

震区道路时断时通场景下的物资调拨后端：省级仓库按批次管理饮水、药品、帐篷等物资，
调拨经历**建单 → 分批装车 → 途中交接 → 到站签收 → 异常退回**五个阶段。
数量以最小发放单位记录，时间采用带时区的 ISO 8601，批次号、调拨单号、凭证号各自全局唯一。

仅依赖 Node.js 标准库（Node ≥ 20），无外部数据库：状态变更全部写入 append-only 日志并
`fsync`，重启后回放日志还原；进程在交接中途退出不会丢失已提交的流转。

## 运行

```bash
npm test          # 36 项测试
npm start         # 默认监听 3000，数据目录 ./data（DATA_DIR 可改，PORT 可改）
GET /health       # {"service":"relief-supply","status":"ok"}
```

## 核心规则

- **批次台账**：每个批次记录类别、保质期（`YYYY-MM-DD` 按东八区当日 23:59:59 到期，也接受完整 ISO 时刻）、存放位置、责任人；库存分 `onHand`（实物）与 `reserved`（已建单未发的占用）。
- **不可分配**：库存可用量不足、批次已过保质期，建单直接拒绝；建单后才过期的批次，装车与追加调整同样拒绝。
- **只调未发**：部分发运后可以调整调拨数量，但不得低于已净发出（发出−退回）的数量。
- **分批装车**：一张调拨单可分多车（`-S01`、`-S02`…），每车数量不得超过该批次的未发额度；装车即扣实物、释放对应预留，并生成首段发车凭证（责任链起点）。
- **凭证责任链**：每次交接生成新凭证并指向前一节点凭证（哈希式链）。下一节点必须出示**当前链末端凭证**才能接货；旧凭证、伪造凭证、错误交出方一律拒绝（409）。
- **到站签收**：持末端凭证按批次核对实收数量；少于装车数量的差额自动登记短缺异常并核销。
- **异常退回**：途中可持末端凭证发起退回（登记异常、责任链转为 `returning`），到省库后确认；退回物资默认重新入库，已过期的不得回库（`restock:false` 按损耗处理），途中短缺同样登记异常。
- **离线补传**：一次提交多条带 `seq` 序号的交接记录，记录用设备端凭证号 `clientCertNo` 互相衔接；服务器原子校验整批——可衔接则全部接受并分配正式凭证号，出现版本分叉（引用的不是链末端）、节点不符、序号缺失/重复、数量非法则**整批拒绝、不落盘任何事件**；相同 `recordId`/`clientCertNo` 重传按幂等处理。已接受的责任链继续向前，冲突设备改用最新末端凭证重发即可。
- **可追溯**：批次库存、目的地汇总、异常清单与调拨旅程时间线可以还原从装车到签收/退回的整段过程。

## HTTP 接口

所有请求/响应均为 JSON。错误返回 `400`（校验失败）、`404`（不存在）、`409`（冲突：库存、凭证、版本分叉等）。

### 批次

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/batches` | 登记批次 |
| GET | `/batches` | 批次列表（`?includeExpired=false` 排除过期） |
| GET | `/batches/:batchNo` | 批次台账（含 available/expired） |
| PATCH | `/batches/:batchNo` | 更新位置、责任人 |

```json
POST /batches
{
  "batchNo": "B-MED-20260920-01",
  "category": "medicine",
  "name": "抗生素",
  "quantity": 200,
  "unit": "盒",
  "expiryDate": "2027-03-31",
  "location": "省库冷库2排",
  "owner": "赵药师"
}
```

类别：`water` / `medicine` / `tent` / `food` / `other`。

### 调拨单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/transfers` | 建单（检查保质期与可用量，数量转为预留） |
| GET | `/transfers` | 列表（可按 `?destination=` 过滤） |
| GET | `/transfers/:no` | 单据与各车批状态 |
| PATCH | `/transfers/:no` | 部分发运后调整**未发数量** |
| POST | `/transfers/:no/cancel` | 取消（释放未发预留；在途车批未闭环时禁止） |
| GET | `/transfers/:no/journey` | 整段旅程时间线（装车、每段凭证、签收/退回） |
| POST | `/transfers/:no/shipments` | 分批装车 |

```json
POST /transfers
{ "transferNo": "TR-001", "destination": "HW", "destinationName": "汉旺安置点",
  "createdBy": "赵药师",
  "lines": [{ "batchNo": "B-MED-20260920-01", "quantity": 30 }] }

POST /transfers/TR-001/shipments
{ "actor": "赵药师", "node": "省库", "toNode": "绵阳中转", "vehicle": "川A-9",
  "lines": [{ "batchNo": "B-MED-20260920-01", "quantity": 30 }] }
```

装车响应返回 `shipment` 与 `departureCert`（链起点凭证）。

### 交接、签收、退回

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/transfers/:t/shipments/:s/handoffs` | 在途中继（`type:"relay"`，须带 `prevCertNo`） |
| POST | `/transfers/:t/shipments/:s/offline-handoffs` | 离线整批补传 |
| POST | `/transfers/:t/shipments/:s/sign` | 到站签收（按批次核数量） |
| POST | `/transfers/:t/shipments/:s/returns` | 发起异常退回 |
| POST | `/transfers/:t/shipments/:s/returns/receive` | 退回到站确认 |

在途中继：

```json
{ "type": "relay", "fromNode": "绵阳中转", "toNode": "汉旺安置点",
  "actor": "李司机", "prevCertNo": "<上一节点凭证号>" }
```

离线补传（设备端在断网期间自行编号凭证，服务器整批校验后映射为正式凭证）：

```json
{ "deviceId": "tablet-7",
  "records": [
    { "seq": 1, "clientCertNo": "DEV-1", "type": "relay",
      "fromNode": "绵阳中转", "toNode": "洛水点", "actor": "李司机",
      "prevCertNo": "<发车凭证>" },
    { "seq": 2, "clientCertNo": "DEV-2", "type": "arrival",
      "fromNode": "洛水点", "toNode": "汉旺安置点", "actor": "张接收",
      "prevCertNo": "DEV-1",
      "quantities": { "B-MED-20260920-01": 28 },
      "exceptions": [{ "batchNo": "B-MED-20260920-01", "reason": "破损2盒" }] }
  ] }
```

- `records` 按 `seq` 升序衔接，每条必须引用链上前一条（首条引用当前链末端）；
- `type` 支持 `relay` / `arrival`（含签收数量）/ `return` / `return_received`（含确认数量与 `restock`）；
- 冲突时返回 `409` 且 `code` 为 `VERSION_CONFLICT` / `NODE_MISMATCH` / `DUPLICATE_RECORD` 等；
- 客户端重试同一批会得到 `DUPLICATE_RECORD`，责任链不会前进第二次。

签收：

```json
{ "actor": "张接收", "node": "汉旺安置点",
  "certNo": "<末端凭证>",
  "quantities": { "B-MED-20260920-01": 27 },
  "exceptions": [{ "batchNo": "B-MED-20260920-01", "reason": "挤压破损3盒" }] }
```

### 查询与异常

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/destinations/summary?destination=HW` | 按目的地+批次聚合（申请/已发/在途/签收/退回/核销/未发） |
| GET | `/destinations/:destination/summary` | 同上 |
| GET | `/exceptions?unresolvedOnly=true` | 异常清单 |
| POST | `/exceptions` | 手工登记异常（damage/expiry/theft/shortage/other） |
| POST | `/exceptions/:no/resolve` | 异常闭环 |

## 持久化与崩溃恢复

- `DATA_DIR/journal.log`：每行一个 JSON 事件（`{seq,type,payload}`），变更先落盘并 `fsync` 再改内存；
  多事件操作（装车+发车凭证、离线整批、签收+到达凭证等）在一次写入与一次 `fsync` 中原子提交。
- `DATA_DIR/snapshot.json`：定期快照（临时文件写后 `rename`），重启时先载快照再回放增量日志。
- 日志末尾若残留进程崩溃时写了一半的行，启动时截断到最后一条完整记录，已提交事件不丢。
- 子进程级恢复见 `test/persistence.test.js`：写一批离线记录后退出，新进程可凭日志继续责任链并完成签收。

## 代码结构

```
src/domain.js   状态结构、事件归约、保质期与单据状态规则（纯函数）
src/store.js    append-only 日志、fsync、快照、崩溃行修复
src/service.js  业务服务：批次/调拨/装车/凭证链/离线补传/签收/退回/视图
src/http.js     零依赖路由器与错误码映射
src/server.js   进程入口
test/           node:test 测试（36 项）
```
