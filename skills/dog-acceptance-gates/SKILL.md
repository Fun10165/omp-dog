---
name: dog-acceptance-gates
description: 用 DoG(DAG of Goals)对非形式化交付物做机械验收:拆成子目标 → 每项一个独立判据 → 落盘证据台账。当用户要求「给这份东西做验收 / 加质量门禁 / 逐项检查是否真的达标」,或交付物是语义性目标(讲得好不好、有没有 AI 味、风格统不统一)无法用一条命令判定时使用。
---

# DoG 验收门禁

把「这份东西做好了没」变成「逐项验收,每项都有独立判据」:每个子目标配一个判据内核,
引擎执行判据并把证据落盘,总目标由子目标的组合表达式算出结果。

**入口是一个命令行程序**,不是 OMP 工具:**`<repo>/cli.ts`**(通常装在 `~/Developer/omp-dog/`)。
用 `bash` 调用;需要 `bun` 或 Node 22.6+。

## 什么时候用 / 什么时候不用

用:交付物是**语义性目标**,拆成若干可分别评看的子目标;需要**可复跑、可继承**的验收
(改完再跑,没变的项 0 成本复用上次判决)。

不用:能用一条命令精确判定的东西(那是普通测试/CI 脚本)。**任何分支都不能全是程序化节点**
——DoG 是判断层,不是规则层的替代品。

边界:**DoG 不执行生成/开发动作**,只判「东西好不好」。产物由你(或你派发的执行者)做出来。

## 工具面(CLI)

```bash
cd <项目目录>
<repo>/cli.ts create <图文件.json> --project .      # 校验 + 固化对象 → 打印 graphId
<repo>/cli.ts run <graphId> --project .             # 判完所有目标 → 打印报告(退出码 0/1)
<repo>/cli.ts status <runId|graphId> --project .    # 读台账
<repo>/cli.ts host --project . --model <m>          # 起一个会话,并在会话里挂 dog_* 工具
```

常用参数:`--concurrency <n>`(并发验证会话数,默认 4)、`--timeout <秒>`(单个判决预算,默认 900)、
`--model <m>` `--thinking <等级>`(验证会话用)。状态落盘在 **`<项目>/.omp/dog/`**。

`create` / `run` / `status` 打印 JSON,直接读它即可,不要靠猜。`run` 的退出码:`0` 表示
`success` 或 `partial_success`,其余为 `1`。

在 `host` 模式里,同样的四件事是四个工具:`dog_validate` / `dog_create` / `dog_run` / `dog_status`。
`dog_run` 会边跑边把逐目标状态推成工具更新。

**你不需要派发任何子代理**:每个 agentic 判据由 `run` 自己起一个 `omp --mode rpc` 验证会话来判,
判决通过宿主工具回调回到引擎。你也**不要自己声称某项已验证**——判决只认验证会话交回的内容。

## 图(schemaVersion `0.9`)

顶层 6 个必填字段:`schemaVersion` / `id` / `root` / `nodes` / `contains` / `dependsOn`。

**节点两种**:

- `leaf`:`{kind, title, constraint: "hard"|"soft", target, verifier}` — `target` 是**工作区相对路径**
  (文件,或目录→引擎冻结成一棵克隆树交给验证会话),`verifier` 必填。
- `composite`:`{kind, title, constraint, target, completion, verifier?}` — `completion` 组合子目标;
  可选的 `verifier` 是**整体断言**(子树全结算后再判一次,**只降不升**)。

**边**:

- `contains`:`{parent, child, required: true|false, failure: "fatal"|"tolerable"|"degrade", degradeTo?}`
  — `fatal` 会把失败传给上级,`tolerable` 只算部分问题,`degrade` 失败时改判 `degradeTo`。
- `dependsOn`:`{source, target}` 读作「**source 等 target 先完成**」。方向常写反:
  想让 A 先跑再跑 B,写 `{source: "B", target: "A"}`。

**completion 表达式**:`{op:"ref",id}` / `{op:"all",items}` / `{op:"any",items}` / `{op:"atLeast",count,items}` / `{op:"not",item}`。

**判据只有两种**:

- `{"mode":"programmatic","script":"file-non-empty"}` — 脚本库 `<repo>/scripts/`;引擎把**冻结副本路径**
  作为唯一参数传给脚本,脚本往 stdout 写 `{"verdict":"pass|fail|inconclusive","evidence":<任意 JSON>}`。
  非零退出或输出不可解析 = `inconclusive`。要新规则就加脚本,别指望在话里描述规则。
- `{"mode":"agentic","instruction":"……"}` — instruction 就是判据。引擎把它连同**冻结的捕获副本**
  交给一个只读的验证会话;那个会话必须调 `dog_submit_verdict` 交回结论与证据。

`root` 必须是 `composite` 且 `constraint: "hard"`。

## 标准流程

```bash
① 写图到文件(嵌套 JSON 手写容易少括号,先写文件再 create)
② <repo>/cli.ts create <图文件> --project .        → 记下 graphId
③ <repo>/cli.ts run <graphId> --project .           → 读报告;退出码 0/1
④ <repo>/cli.ts status <runId> --project .          → 需要逐目标证据时再读
```

产物改了之后必须**重新 `create`**(重新冻结字节);否则引擎判的还是旧字节。

## 结果语义

| 看到 | 含义 | 你该做什么 |
|---|---|---|
| `rootState: "success"` | 各硬项全过 | 汇报通过 + 关键 evidence |
| `rootState: "failure"` | 有 fatal 项失败 | 找出 `failure` 节点,把 evidence/reason 里的具体罪名转达用户 |
| `rootState: "needs_replan"` | 有节点判不了 | **不要猜**;如实转达「无法自动判定 + 原因」 |
| `rootState: "partial_success"` | 根是 partial 且部署允许 | 说明哪项是 tolerable 失败 |
| goal `inherited` | 对象与判据都没变,复用上次判决 | 正常,`inheritedFrom` 指向来源 run |
| goal `needs_human` | 判据执行器诚实说判不了 | 转达理由;要更精确就改 instruction 后重新 create |
| goal `blocked` | 依赖项未完成 | 看 `dependsOn` |

每个 agentic 目标的判决里带 `verifier.sessionFile`(验证会话的转写路径):要复盘「它凭什么这么判」,
读那份转写。

## 写判据的纪律

- **一句话一个判据**,判据里写清标准与不可接受的形态;不要写「写得好不好」这种没有落点的要求。
- 判据要能被**独立复核**:合格的判据自己决定取证方式,但结论必须能对着证据重新检查。
- 判不了就让它判不了:验证会话说 `inconclusive` 是设计内的诚实,不是失败,更不是通过。
- 机械规则(文件存在、字数、禁用词表)写脚本;需要判断力的写 instruction。

## 常见错误

1. `target` 用了绝对路径 → 拒绝;必须是工作区内的**相对路径**。
2. **把整棵子树写成全程序化** → 那不是 DoG;全规则的部分交给普通测试/脚本。
3. `verifier` 里写了 `mode/script/instruction` 以外的字段(id/参数/工具白名单) → 不存在,会报错。
4. leaf 忘写 `verifier`,节点忘写 `target`,或 root 不是 `hard` → `create` 直接拦。
5. `dependsOn` 方向写反 → 顺序反了,或者无谓地串行。
6. 产物改了却不重新 `create` → 判的仍是旧字节(引擎按捕获摘要判继承)。

## 报告格式(收口用)

```
图: <id> @ <graphDigest 前 12>
run: <runId>  终态: <rootState>
节点: <goalId> | <state> | 证据摘要 / 失败原因
根结果: 通过/不通过 + 一句话原因
```
