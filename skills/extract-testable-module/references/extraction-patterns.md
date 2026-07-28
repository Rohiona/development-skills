# 技法カタログ（before → after）

厚いメソッドをテスト可能にする代表的な技法を、TypeScript の具体例で示す。
コードは説明用に簡略化している。実際のプロジェクトでは命名・配置・テスト慣習を近隣調査で合わせること。

## 目次

1. Extract Function（純粋ロジックの抽出）— 最頻出・最高価値
2. パラメータ化（隠れた入力を引数にする）
3. 依存注入（外部依存を差し替え可能にする）
4. Sprout Method / Sprout Class（既存に触らず芽吹かせる）
5. 既存 private の共有（別モジュールへ引き上げる）
6. rate-of-change で層を割る（揮発な adapter ↔ 安定な policy）
7. Jest でのテストの書き方

---

## 1. Extract Function（純粋ロジックの抽出）

厚いメソッドから、副作用のない判断・変換・検証を関数として剥がす。引数と戻り値だけでテストできる状態にするのが目的。

### before（厚い private メソッド）

```typescript
class WorkflowService {
  constructor(private repo: WorkflowRepository) {}

  async createWorkflow(req: CreateWorkflowRequest): Promise<Workflow> {
    // ↓ ここから純粋ロジック（パース＋バリデーション＋変換）が埋まっている
    const data: WorkflowCreateInput = { name: req.name }
    if (req.recurringExecution) {
      let recurring: RecurringExecution
      try {
        recurring = JSON.parse(req.recurringExecution)
      } catch {
        throw new AppError(AppErrorCodes.InvalidArgument, 'recurringExecution が不正な JSON です')
      }
      if (recurring.intervalDays <= 0) {
        throw new AppError(AppErrorCodes.InvalidArgument, 'intervalDays は正の数である必要があります')
      }
      data.recurringExecution = recurring
    }
    // ↑ ここまで純粋ロジック
    return this.repo.create(data) // ← 副作用（I/O）はメソッドに残す
  }
}
```

テストしようとすると、`repo` をモックしないと純粋ロジックすら検証できない。分岐ごとに毎回モックが要る。

### after（純粋関数を抽出）

```typescript
// workflow-input.ts（純粋ロジックだけ。I/O も this も持たない）
export function buildWorkflowCreateInput(req: CreateWorkflowRequest): WorkflowCreateInput {
  const data: WorkflowCreateInput = { name: req.name }
  if (req.recurringExecution) {
    data.recurringExecution = parseRecurringExecution(req.recurringExecution)
  }
  return data
}

export function parseRecurringExecution(raw: string): RecurringExecution {
  let recurring: RecurringExecution
  try {
    recurring = JSON.parse(raw)
  } catch {
    throw new AppError(AppErrorCodes.InvalidArgument, 'recurringExecution が不正な JSON です')
  }
  if (recurring.intervalDays <= 0) {
    throw new AppError(AppErrorCodes.InvalidArgument, 'intervalDays は正の数である必要があります')
  }
  return recurring
}
```

```typescript
// workflow.service.ts（オーケストレーションだけが残り、薄くなる）
async createWorkflow(req: CreateWorkflowRequest): Promise<Workflow> {
  const data = buildWorkflowCreateInput(req)
  return this.repo.create(data)
}
```

純粋関数はモックなしで全分岐をテストできる。元メソッドは「組み立てて保存するだけ」になり、責務が一目で分かる。

---

## 2. パラメータ化（隠れた入力を引数にする）

純粋に見えて、内部で時刻・乱数・環境変数・インスタンス変数を読んでいると決定的にならずテストしにくい。隠れた入力を引数に上げる。

### before

```typescript
function isExpired(token: Token): boolean {
  return token.expiresAt < Date.now() // 暗黙の時刻依存。テストが時刻に左右される
}
```

### after

```typescript
function isExpired(token: Token, now: number): boolean {
  return token.expiresAt < now // now を渡せば決定的にテストできる
}
```

呼び出し側で `isExpired(token, Date.now())` とする。副作用（現在時刻の取得）は呼び出し側に押し出し、判断ロジックは純粋に保つ。

---

## 3. 依存注入（外部依存を差し替え可能にする）

外部依存を関数内で直接 `new` / 直接呼び出ししていると差し替えられない。依存を引数やコンストラクタで受け取る形にする。注入の流儀はプロジェクトに合わせる（コンストラクタ注入が主流ならそれに倣う）。

### before

```typescript
async function notifyUser(userId: string): Promise<void> {
  const client = new LineClient(process.env.LINE_TOKEN!) // 直接生成。テストで差し替え不可
  const user = await new UserRepository(createDatabaseAuto()).findById(userId)
  await client.push(user.lineId, 'こんにちは')
}
```

### after

```typescript
// 依存をインターフェースで受け取る
interface Notifier {
  push(to: string, message: string): Promise<void>
}
interface UserReader {
  findById(id: string): Promise<User>
}

export async function notifyUser(userId: string, deps: { notifier: Notifier; users: UserReader }): Promise<void> {
  const user = await deps.users.findById(userId)
  await deps.notifier.push(user.lineId, 'こんにちは')
}
```

テストでは `deps` にテストダブルを渡す。本番の組み立て（実 client の生成）は呼び出し側 / DI コンテナに集約する。

---

## 4. Sprout Method / Sprout Class（既存に触らず芽吹かせる）

既存メソッドが巨大で安全に分解しにくい、または新しい責務を足したいとき。既存を分解せず、新しいテスト可能な単位を脇に作り、既存からは最小限だけ呼ぶ。Michael Feathers が『レガシーコード改善ガイド』で示した技法。

### Sprout（新ロジックを別モジュールに新設し、1 行だけ繋ぐ）

```typescript
// 新設: discount.ts（最初からテスト可能な純粋関数）
export function calculateDiscount(order: Order, coupons: Coupon[]): number {
  // 新しい割引ロジック。単体テストを先に green にしておく
  ...
}
```

```typescript
// 既存の巨大な checkout()。中身は分解せず、1 行だけ追加して繋ぐ
async checkout(order: Order): Promise<Receipt> {
  // ...既存の 200 行はそのまま...
  const discount = calculateDiscount(order, await this.couponRepo.list(order.userId)) // ← 芽吹かせた呼び出し
  // ...既存処理の続き...
}
```

既存コードへの変更は実質 1 行。新しい価値（割引計算）はテスト可能なモジュールとして独立する。「既存を全部きれいにする」誘惑に乗らず、追加分の品質だけを担保する。

### Sprout Class

新責務が状態や複数メソッドを持つなら、関数ではなくクラスとして新設し、既存からインスタンス化して呼ぶ。判断は同じ: 既存には触らず、新設側をテスト可能に。

---

## 5. 既存 private を別モジュールへ引き上げて共有する

ある private メソッドのロジックを、別の新規モジュールからも使いたくなったとき。コピペせず、独立モジュールへ抽出して両者から呼ぶ。

### before

```typescript
class FriendService {
  private normalizePhone(raw: string): string { /* 正規化ロジック */ }
}
// 別の新規モジュールでも同じ正規化が必要になった → コピペしたくなる
```

### after

```typescript
// phone.ts（独立した純粋関数。両者から import）
export function normalizePhone(raw: string): string { /* 正規化ロジック */ }
```

```typescript
class FriendService {
  // private は消し、normalizePhone(raw) を呼ぶだけにする
}
```

これで 1 箇所でテストすれば両方の利用箇所がカバーされ、ロジックの二重管理もなくなる。

---

## 6. rate-of-change で層を割る（揮発な adapter ↔ 安定な policy）

純粋ロジックの抽出（§1）の親戚だが、判断軸が違う。§1 は「副作用の有無」で割る。ここは **変更頻度・変更理由（rate-of-change）** で割る。1 つの小さな関数が「外部フォーマット・契約に結びつく揮発な取り出し（adapter）」と「外部が変わっても変わらない安定な判定（policy）」をまたいでいたら、deletion test 上は浅く見えても層として分ける。狙いは複雑性の隠蔽ではなく **変更の波及を断つ** こと。

### before（揮発な取り出しと安定な判定が 1 関数に同居）

```typescript
// entry-routing.ts
// 「封筒のどこに platform が載るか（揮発）」と「kind→route の判定（安定）」が混ざっている
export function resolveRoute(envelope: DeliveryEnvelope): Route {
  // ↓ 揮発: SQS 封筒のどのフィールドに platform 情報が載るかは外部契約の都合で変わる
  const kind = envelope.messageAttributes?.platformKind?.stringValue ?? envelope.body?.kind ?? 'line'
  // ↓ 安定: kind → route は業務ポリシー。封筒形式が変わっても変わらない
  switch (kind) {
    case 'line': return { queue: 'line-dispatch' }
    case 'mpf':  return { queue: 'mpf-dispatch' }
    default:     throw new AppError(AppErrorCodes.InvalidArgument, `未知の platformKind: ${kind}`)
  }
}
```

封筒の載せ方が変わる（揮発）たびに、`resolveRoute` のテストごと巻き添えで直す羽目になる。逆にルート追加（安定の変更）でも封筒パースのモックが要る。変更理由が 2 つ同居している。

### after（揮発 adapter / 安定 policy / 合成 の 3 層）

```typescript
// platform-kind.ts — 揮発な adapter（封筒からの取り出しと検証。外部契約が変わったらここだけ直す）
const PLATFORM_KINDS = ['line', 'mpf'] as const
export type PlatformKind = (typeof PLATFORM_KINDS)[number]

function isPlatformKind(v: string): v is PlatformKind {
  return PLATFORM_KINDS.some((k) => k === v)
}

// parse, don't validate: 裸の `as PlatformKind` で型を「宣言」せず、検証して絞った型で返す。
// 未知の値は境界（ここ）で弾くので、policy 側は PlatformKind だけを見ればよい。
export function extractPlatformKind(envelope: DeliveryEnvelope): PlatformKind {
  const raw = envelope.messageAttributes?.platformKind?.stringValue ?? envelope.body?.kind ?? 'line'
  if (!isPlatformKind(raw)) {
    throw new AppError(AppErrorCodes.InvalidArgument, `未知の platformKind: ${raw}`)
  }
  return raw
}

// platform-route.ts — 安定な policy（純ポリシー。封筒を知らない。kind だけ受ける）
export function routeForPlatformKind(kind: PlatformKind): Route {
  switch (kind) {
    case 'line': return { queue: 'line-dispatch' }
    case 'mpf':  return { queue: 'mpf-dispatch' }
    default: {
      // union を網羅していれば到達不能。kind の追加漏れをコンパイラが検出する（exhaustiveness check）
      const exhaustive: never = kind
      throw new AppError(AppErrorCodes.InvalidArgument, `未知の platformKind: ${exhaustive}`)
    }
  }
}

// entry-routing.ts — 合成（薄いオーケストレーション。1 行ずつ呼ぶだけ）
export function resolvePlatformRoute(envelope: DeliveryEnvelope): Route {
  return routeForPlatformKind(extractPlatformKind(envelope))
}
```

`routeForPlatformKind` は封筒を知らない純ポリシーなので、ルート分岐のテストはモック無し・封筒形式と無関係に書ける。封筒の載せ方が変わっても `extractPlatformKind` のテストだけが動き、ポリシーのテストは 1 行も壊れない。これが rate-of-change で割る配当。

**型が接合面を固くする**: adapter は検証（type guard）で絞った `PlatformKind` を返す（parse, don't validate — `design-principles.md` 2-(e)）。裸の `as` キャストで型を宣言すると、未知の値が policy まで素通りして層分離が型の上で崩れる。未知値の拒否は境界（adapter）に置き（エラーは分離前と同一＝挙動不変）、policy の `switch` は union を網羅して `never` チェックでケース追加漏れをコンパイラに検出させる。

### アンチパターン: export-as-private（テストのために内部を晒すだけ）

「ルート判定をテストしたい」を **`resolveRoute` の内部分岐をそのまま `export` する／private を public にするだけ** で済ませてはいけない。それは責務を割っておらず、揮発（封筒パース）と安定（判定）が同居したまま「テスト用に内部を晒した」だけ。テストは結局封筒のモックを必要とし、変更の波及も断てない。

```typescript
// アンチパターン: 中身は混ざったまま、テストのために晒しただけ
export function resolveRoute(envelope: DeliveryEnvelope): Route { /* 揮発+安定が同居 */ }
// ↑ これを「テスト可能にした」と呼ばない
```

**正は「責務の再概念化＝層分離」**（adapter / policy / 合成）であって、「export-as-private（内部の晒し出し）」ではない。晒し出しは凝集を上げず、テストの依存も減らさない。

### 据え置き（分離しない）の正しい判断

すべての小関数を割るわけではない。**揮発と安定が混ざっていないなら据え置く。** 例えば `routeForPlatformKind` 単体（kind→route のみ）は既に安定だけの純ポリシーで、これ以上割ると断片化（§設計原則 4 / 凝集度の低下）になる。据え置きを選ぶときは「外部フォーマットが変わってもこの関数のテストは壊れない」ことを確認した上で据え置く。

---

## 7. Jest でのテストの書き方

プロジェクトが Jest の場合の典型（一例。導入先プロジェクトの慣習に合わせる）。フレームワークが違えばそれに合わせる。

### 純粋関数（モック不要）

```typescript
import { parseRecurringExecution } from './workflow-input'
import { AppError } from '../shared/appError'

describe('parseRecurringExecution', () => {
  it('正常な JSON をパースして返す', () => {
    expect(parseRecurringExecution('{"intervalDays":7}')).toEqual({ intervalDays: 7 })
  })

  it('不正な JSON なら AppError を投げる', () => {
    expect(() => parseRecurringExecution('not json')).toThrow(AppError)
  })

  it('intervalDays が 0 以下なら AppError を投げる', () => {
    expect(() => parseRecurringExecution('{"intervalDays":0}')).toThrow(/正の数/)
  })
})
```

### 依存を注入する単位（テストダブルを渡す）

```typescript
import { notifyUser } from './notify-user'

describe('notifyUser', () => {
  it('ユーザーの lineId 宛にメッセージを送る', async () => {
    const push = jest.fn().mockResolvedValue(undefined)
    const users = { findById: jest.fn().mockResolvedValue({ lineId: 'U123' }) }

    await notifyUser('user-1', { notifier: { push }, users })

    expect(users.findById).toHaveBeenCalledWith('user-1')
    expect(push).toHaveBeenCalledWith('U123', 'こんにちは')
  })
})
```

### モジュール全体をモックする（既存クラスの依存差し替え）

```typescript
import { FriendRepository } from '@yourorg/data-access/drizzle'
import { FriendService } from './friend.service'

jest.mock('@yourorg/data-access/drizzle')

describe('FriendService', () => {
  let repo: jest.Mocked<FriendRepository>
  beforeEach(() => {
    repo = new FriendRepository({} as never) as jest.Mocked<FriendRepository>
  })
  // ...
})
```

純粋関数として切り出せていれば、3 つ目のような重いモックは要らなくなる。**モックが減ったかどうか** が、切り出しがうまくいった指標になる。
