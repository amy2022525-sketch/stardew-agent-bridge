/**
 * 28 个 Agent 工具的单一事实来源：MCP 工具定义、Web 表单约束、文档示例共用。
 *
 * 重要：工具名带 `stardew_` 前缀，避免与宿主自带工具冲突。
 * `modArgs` 负责把工具表面参数映射成 Mod 内部命令参数，保证模型只需看这里的文档。
 */
import {
    ACTION_ID_PATTERN,
    COMBAT_MAX_MS,
    FISH_MAX_MS,
    SAVE_ID_PATTERN,
    TARGET_REF_PATTERN,
    WAIT_MAX_MS
} from './protocol.js';
import type { ToolKind } from './protocol.js';

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
    name: string;
    title: string;
    /** 面向模型的中文说明：包含限制、失败语义与禁止行为。 */
    description: string;
    /** Mod 内部命令名；Bridge 内部命令用 `bridge:` 前缀。 */
    command: string;
    kind: ToolKind;
    inputSchema: JsonSchema;
    annotations: {
        title: string;
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
    /** 工具参数 → Mod 命令参数。 */
    modArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
    /** 写工具默认动作超时。 */
    timeoutMs?: number;
}

const ACTION_ID_PROP = {
    type: 'string',
    pattern: ACTION_ID_PATTERN,
    description:
        '逻辑动作 ID（1–80 位字母数字/下划线/横线），建议显式提供。同一 ID 且参数相同只返回原收据、不重复消费；同一 ID 但参数不同返回 IDEMPOTENCY_CONFLICT。省略时由 Bridge 生成并记录在当前控制会话。'
};

const CONTROL_SESSION_PROP = {
    type: 'string',
    description:
        '控制会话 ID（stardew_session operation=start 返回）。省略时使用该 clientId 唯一活动控制会话；零个或多个时返回 CONTROL_REQUIRED。同一 clientId 的聊天可能共享该会话，独立控制者应使用不同 clientId 并显式传入会话 ID。'
};

function writeSchema(properties: JsonSchema, required: string[] = []): JsonSchema {
    return {
        type: 'object',
        properties: { ...properties, actionId: ACTION_ID_PROP, controlSessionId: CONTROL_SESSION_PROP },
        required,
        additionalProperties: false
    };
}

function readSchema(properties: JsonSchema = {}, required: string[] = []): JsonSchema {
    return { type: 'object', properties, required, additionalProperties: false };
}

function annotations(title: string, readOnly: boolean, destructive = false): ToolSpec['annotations'] {
    return { title, readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: !destructive, openWorldHint: true };
}

const TARGET_PROP = (what: string) => ({
    type: 'string',
    pattern: TARGET_REF_PATTERN,
    description: `${what} 的引用，格式形如 @s12:e3（必须来自最近一次 stardew_snapshot，换图或菜单变化后失效）。`
});

const SLOT_PROP = (max: number, what = '背包槽位') => ({
    type: 'integer',
    minimum: 0,
    maximum: max,
    description: `${what}，从 0 开始（0–${max}）。`
});

export const TOOLS: readonly ToolSpec[] = [
    {
        name: 'stardew_doctor',
        title: '诊断连接与版本',
        description:
            '读取真实连接状态：Mod/Bridge/游戏/SMAPI 版本、内部协议、当前控制权代次、能力清单、是否已加载存档、暂停与看门狗状态。不改变游戏。游戏未启动时仍可返回 Bridge 侧诊断。',
        command: 'hello',
        kind: 'read',
        inputSchema: readSchema(),
        annotations: annotations('诊断连接与版本', true)
    },
    {
        name: 'stardew_snapshot',
        title: '观察游戏快照',
        description:
            '读取当前真实世界的紧凑快照：日期时间、生命体力、金钱、背包、附近地块与对象引用、出口、菜单选项、作物成熟状态、阻塞原因。返回的 @sN:eM 引用用于后续动作。默认半径 5，最大 16；面积越大输出越大，超过硬上限会返回 OUTPUT_LIMIT，请缩小半径。',
        command: 'snapshot',
        kind: 'read',
        inputSchema: readSchema({
            radius: { type: 'integer', minimum: 1, maximum: 16, description: '观察半径（格），默认 5。' },
            includeTiles: { type: 'boolean', description: '保留兼容字段，当前恒为完整地块列表；缩小半径即可减少输出。' }
        }),
        annotations: annotations('观察游戏快照', true),
        modArgs: (args) => (typeof args.radius === 'number' ? { radius: args.radius } : {})
    },
    {
        name: 'stardew_inspect',
        title: '读取目标详情',
        description:
            '按需读取单个引用的详细状态：可站立性、作物阶段与是否可采收、水面可钓鱼、树木生命、对象 itemId/品质/数量、建筑范围、怪物生命、世界状态与阻塞原因。只读。',
        command: 'inspect',
        kind: 'read',
        inputSchema: readSchema({ target: TARGET_PROP('场景目标或菜单') }, ['target']),
        annotations: annotations('读取目标详情', true)
    },
    {
        name: 'stardew_screenshot',
        title: '截取当前画面',
        description:
            '截取真实游戏画面并以标准 MCP 图片内容返回（PNG），附采样时间与观察元数据。仅支持图片的模型需要；文字模型不需要调用。分辨率过高时返回 OUTPUT_LIMIT。',
        command: 'screenshot',
        kind: 'read',
        inputSchema: readSchema(),
        annotations: annotations('截取当前画面', true)
    },
    {
        name: 'stardew_status',
        title: '读取控制与动作状态',
        description:
            '读取 Bridge 侧状态：当前控制者与会话、在途动作、未决动作、最近收据、暂停结果、账本可写性与 Mod 连接。用于返回丢失后核对，不会重新执行任何消费动作。',
        command: 'bridge:status',
        kind: 'read',
        inputSchema: readSchema({ actionId: { type: 'string', pattern: ACTION_ID_PATTERN, description: '查询该动作的原收据；不重放动作。' } }),
        annotations: annotations('读取控制与动作状态', true)
    },
    {
        name: 'stardew_move',
        title: '正常移动到目标',
        description:
            '按游戏碰撞与距离规则寻路移动到目标格或目标附近（柜台从南侧接近）。只提供 near 或 x/y 之一；-1 仅允许真实边界出口。到达后返回位置与快照。不可达时返回 PATH_BLOCKED 并说明邻格阻挡情况；不使用瞬移。',
        command: 'move',
        kind: 'write',
        inputSchema: {
            type: 'object',
            properties: {
                near: {
                    type: 'string',
                    pattern: TARGET_REF_PATTERN,
                    description: '目标引用：走到该目标的可交互相邻格。与 x/y 互斥。'
                },
                x: { type: 'integer', minimum: -1, description: '绝对格子 x。与 y 同时提供；-1 仅允许真实地图出口。' },
                y: { type: 'integer', minimum: -1, description: '绝对格子 y。' },
                actionId: ACTION_ID_PROP,
                controlSessionId: CONTROL_SESSION_PROP
            },
            additionalProperties: false
        },
        annotations: annotations('正常移动到目标', false),
        modArgs: (args) => {
            if (typeof args.near === 'string') return { near: args.near };
            return { tile: { x: args.x, y: args.y } };
        },
        timeoutMs: 30_000
    },
    {
        name: 'stardew_select',
        title: '选择背包槽位',
        description: '选择背包槽位中的真实工具或物品（当前手持）。只切换选择，不使用工具。',
        command: 'select',
        kind: 'write',
        inputSchema: writeSchema({ slot: SLOT_PROP(35) }, ['slot']),
        annotations: annotations('选择背包槽位', false)
    },
    {
        name: 'stardew_use',
        title: '使用工具或种子',
        description:
            '对相邻目标使用当前已选工具或种子（锄地、浇水、砍树、放置种子等）。需要角色与目标曼哈顿距离 ≤1，否则返回 OUT_OF_REACH（先 move）。结果以实际地块、资源与体力变化为准。',
        command: 'use',
        kind: 'write',
        inputSchema: writeSchema({ target: TARGET_PROP('要作用的场景目标') }, ['target']),
        annotations: annotations('使用工具或种子', false)
    },
    {
        name: 'stardew_interact',
        title: '与对象或 NPC 交互',
        description:
            '正常交互附近对象、门、NPC 或信箱（开门、对话、上床睡觉、查看告示等）。菜单类交互请再用 stardew_menu 选择真实选项。需要相邻距离。',
        command: 'interact',
        kind: 'write',
        inputSchema: writeSchema({ target: TARGET_PROP('要交互的场景目标') }, ['target']),
        annotations: annotations('与对象或 NPC 交互', false)
    },
    {
        name: 'stardew_menu',
        title: '选择菜单选项',
        description:
            '选择当前快照给出的真实菜单选项（对话、信件、结算、升级等）。引用来自 snapshot 的 menu.options，且菜单内容变化后失效（MENU_MISMATCH）。不跳过剧情，不代替用户关闭菜单。',
        command: 'menu',
        kind: 'write',
        inputSchema: writeSchema({ target: TARGET_PROP('菜单选项') }, ['target']),
        annotations: annotations('选择菜单选项', false)
    },
    {
        name: 'stardew_wait',
        title: '等待动画或剧情推进',
        description:
            `等待正常动画或剧情推进（100–${WAIT_MAX_MS} 毫秒）后返回新快照。不修改游戏时钟、不跳过剧情。等待本身会推进游戏时间。`,
        command: 'wait',
        kind: 'write',
        inputSchema: writeSchema({
            milliseconds: { type: 'integer', minimum: 100, maximum: WAIT_MAX_MS, description: '等待毫秒数，默认 1000。' }
        }),
        annotations: annotations('等待动画或剧情推进', false),
        modArgs: (args) => ({ milliseconds: typeof args.milliseconds === 'number' ? args.milliseconds : 1000 })
    },
    {
        name: 'stardew_pause',
        title: '打开正常暂停菜单',
        description:
            '打开游戏自身的菜单来暂停单人时钟（默认分步模式在每段动作结束后自动尝试）。不会关闭用户自己打开的菜单，也不会跳过剧情；无法暂停时返回真实 blocked/unknown 状态。',
        command: 'pause',
        kind: 'write',
        inputSchema: writeSchema({}),
        annotations: annotations('打开正常暂停菜单', false)
    },
    {
        name: 'stardew_closemenu',
        title: '关闭游戏菜单',
        description:
            '通过游戏正常关闭入口关闭普通菜单（游戏菜单、商店、信件、物品菜单、制作页）。若仍有未领取附件或手持物品会返回原因而不丢弃物品。剧情/结算菜单需用 stardew_menu 推进。',
        command: 'closemenu',
        kind: 'write',
        inputSchema: writeSchema({}),
        annotations: annotations('关闭游戏菜单', false)
    },
    {
        name: 'stardew_shop',
        title: '读取商店货架',
        description: '读取当前已打开商店的真实货架、价格、库存与 itemId（只读）。需要游戏内已打开商店菜单。',
        command: 'shop',
        kind: 'read',
        inputSchema: readSchema(),
        annotations: annotations('读取商店货架', true)
    },
    {
        name: 'stardew_buy',
        title: '购买物品',
        description:
            '在已打开的商店购买指定 itemId 与数量并核验入包与扣款。可部分成交，返回 requestedCount/actualCount/goldBefore/goldAfter。结果不明时不要用新 actionId 重试。',
        command: 'buy',
        kind: 'write',
        inputSchema: writeSchema(
            {
                itemId: { type: 'string', minLength: 1, maxLength: 64, description: 'stardew_shop 返回的精确 itemId，例如 (O)472。' },
                count: { type: 'integer', minimum: 1, maximum: 999, description: '请求数量（1–999），按回执实际数量记账。' }
            },
            ['itemId', 'count']
        ),
        annotations: annotations('购买物品', false, true)
    },
    {
        name: 'stardew_ship',
        title: '投放到出货箱',
        description:
            '把背包指定槽位的物品投放到附近真实出货箱并核验转移。收入要到次日结算，投放数量与结算金额分别核对，未结算不计作已获得金币。',
        command: 'ship',
        kind: 'write',
        inputSchema: writeSchema(
            {
                target: TARGET_PROP('出货箱'),
                slot: SLOT_PROP(35),
                count: { type: 'integer', minimum: 1, maximum: 999, description: '本次投放数量（1–999）。' }
            },
            ['target', 'slot', 'count']
        ),
        annotations: annotations('投放到出货箱', false, true)
    },
    {
        name: 'stardew_container',
        title: '查看或转移箱子物品',
        description:
            '读取附近箱子（operation=list）或按槽位存入/取出。deposit 的 slot 属于背包，withdraw 的 slot 属于箱子。deposit/withdraw 是写动作，会核验实际转移数量并如实报告部分完成。',
        command: 'container',
        kind: 'mixed',
        inputSchema: writeSchema(
            {
                target: TARGET_PROP('箱子'),
                operation: { type: 'string', enum: ['list', 'deposit', 'withdraw'], description: '箱子操作。' },
                slot: { type: 'integer', minimum: 0, maximum: 71, description: 'list 可省略；deposit 为背包槽位 0–35，withdraw 为箱内槽位 0–71。' },
                count: { type: 'integer', minimum: 1, maximum: 999, description: '转移数量（1–999），list 可省略。' }
            },
            ['target', 'operation']
        ),
        annotations: annotations('查看或转移箱子物品', false),
        modArgs: (args) => {
            const out: Record<string, unknown> = { target: args.target, operation: args.operation };
            if (typeof args.slot === 'number') out.slot = args.slot;
            if (typeof args.count === 'number') out.count = args.count;
            return out;
        }
    },
    {
        name: 'stardew_recipes',
        title: '读取已知制作配方',
        description: '读取角色真实已知的制作配方、材料与当前可制作数量（只读）。craft 使用这里的精确 recipe 名称。',
        command: 'recipes',
        kind: 'read',
        inputSchema: readSchema(),
        annotations: annotations('读取已知制作配方', true)
    },
    {
        name: 'stardew_craft',
        title: '按配方制作',
        description:
            '按真实配方名称制作并核验材料消耗与成品。注意 count 是“制作次数”，回执同时报告实际消耗与产出。材料不足返回 INSUFFICIENT_RESOURCE，部分完成如实报告。',
        command: 'craft',
        kind: 'write',
        inputSchema: writeSchema(
            {
                recipe: { type: 'string', minLength: 1, maxLength: 80, description: 'stardew_recipes 返回的精确 recipe 名称，不能猜显示名称。' },
                count: { type: 'integer', minimum: 1, maximum: 999, description: '制作次数（1–999）。' }
            },
            ['recipe', 'count']
        ),
        annotations: annotations('按配方制作', false, true)
    },
    {
        name: 'stardew_place',
        title: '放置物品到地块',
        description: '把指定背包槽位物品正常放置到附近真实目标地块（放置设备、种子等）。失败不视为已放置。',
        command: 'place',
        kind: 'write',
        inputSchema: writeSchema({ target: TARGET_PROP('目标地块'), slot: SLOT_PROP(35) }, ['target', 'slot']),
        annotations: annotations('放置物品到地块', false, true)
    },
    {
        name: 'stardew_eat',
        title: '食用背包物品',
        description: '正常食用指定背包物品并核对实际体力、生命与数量变化。没有体力收益的物品会被拒绝。',
        command: 'eat',
        kind: 'write',
        inputSchema: writeSchema({ slot: SLOT_PROP(35) }, ['slot']),
        annotations: annotations('食用背包物品', false, true)
    },
    {
        name: 'stardew_equip',
        title: '穿戴或卸下装备',
        description:
            '穿戴或卸下帽子、靴子、戒指、上衣、裤子并核对实际装备槽位。operation=unequip 时 slot 指定接收装备的空背包格。',
        command: 'equip',
        kind: 'write',
        inputSchema: writeSchema(
            {
                slot: SLOT_PROP(35, '背包槽位（unequip 时为接收格）'),
                kind: {
                    type: 'string',
                    enum: ['hat', 'boots', 'leftRing', 'rightRing', 'pants', 'shirt'],
                    description: '目标装备槽。'
                },
                operation: { type: 'string', enum: ['equip', 'unequip'], description: '默认 equip。' }
            },
            ['slot', 'kind']
        ),
        annotations: annotations('穿戴或卸下装备', false, true)
    },
    {
        name: 'stardew_fish',
        title: '在真实水域钓鱼',
        description:
            `使用当前已选鱼竿在水域执行有界钓鱼（最长 ${FISH_MAX_MS} 毫秒），程序控制逐帧输入。回执区分“进行中”和“实际捕获”，超时不等于钓到鱼。宿主工具超时需 ≥70 秒。`,
        command: 'fish',
        kind: 'write',
        inputSchema: writeSchema({
            target: {
                type: 'string',
                pattern: TARGET_REF_PATTERN,
                description: '水面目标引用（可选）：提供时先走到其相邻格再抛竿。'
            },
            milliseconds: { type: 'integer', minimum: 100, maximum: FISH_MAX_MS, description: `本次控制时长（100–${FISH_MAX_MS}），默认 45000。` }
        }),
        annotations: annotations('在真实水域钓鱼', false),
        modArgs: (args) => {
            const out: Record<string, unknown> = {};
            if (typeof args.target === 'string') out.target = args.target;
            out.milliseconds = typeof args.milliseconds === 'number' ? args.milliseconds : 45_000;
            return out;
        },
        timeoutMs: 60_000
    },
    {
        name: 'stardew_combat',
        title: '基础近战',
        description:
            `使用已选真实武器进行有界近战（最长 ${COMBAT_MAX_MS} 毫秒），达到生命阈值即停止。报告真实生命/伤害变化与停止原因；超时不等于击杀。`,
        command: 'combat',
        kind: 'write',
        inputSchema: writeSchema(
            {
                target: TARGET_PROP('怪物'),
                milliseconds: { type: 'integer', minimum: 100, maximum: COMBAT_MAX_MS, description: `本次控制时长（100–${COMBAT_MAX_MS}），默认 1000。` },
                minHealth: { type: 'integer', minimum: 1, maximum: 999, description: '低于该生命值即停止，默认 30。' }
            },
            ['target']
        ),
        annotations: annotations('基础近战', false),
        timeoutMs: 15_000
    },
    {
        name: 'stardew_session',
        title: '控制会话',
        description:
            '显式控制会话：start 取得写入权并返回 controlSessionId（不强占已有控制者，冲突返回 CONTROL_BUSY）；status 只读；checkpoint 保存目标/进度/下一步供下次恢复；end 释放控制并尝试正常暂停。只读工具不需要会话，也不会续租。',
        command: 'bridge:session',
        kind: 'control',
        inputSchema: readSchema(
            {
                operation: { type: 'string', enum: ['start', 'status', 'checkpoint', 'end'], description: '会话操作。' },
                mode: { type: 'string', enum: ['step', 'realtime'], description: 'start 时使用：step（默认，动作后尝试暂停）或 realtime（连续实时，受会话时限约束）。' },
                controlSessionId: { type: 'string', description: 'status/checkpoint/end 时的会话 ID；省略时使用该客户端唯一活动会话。' },
                goal: { type: 'string', maxLength: 2000, description: 'checkpoint：用户目标。' },
                progress: { type: 'string', maxLength: 4000, description: 'checkpoint：已由回执证明的进展。' },
                next: { type: 'string', maxLength: 2000, description: 'checkpoint：尚未完成的下一步。' },
                constraints: { type: 'string', maxLength: 2000, description: 'checkpoint：用户约束与资源边界。' }
            },
            ['operation']
        ),
        annotations: annotations('控制会话', false)
    },
    {
        name: 'stardew_saves',
        title: '列出本机存档',
        description: '只读列出本机实际可加载存档的精确 saveId 与角色信息。不加载、不覆盖存档。',
        command: 'saves',
        kind: 'read',
        inputSchema: readSchema(),
        annotations: annotations('列出本机存档', true)
    },
    {
        name: 'stardew_load',
        title: '加载存档',
        description:
            '仅在标题页按 saves 返回的精确 saveId 启动正常加载；当前已加载存档时拒绝，不自动退出运行中的存档。accepted 只表示已接受，必须再用 stardew_snapshot 确认 ready；加载会改变 worldGeneration 并使旧会话失效。',
        command: 'load',
        kind: 'write',
        inputSchema: writeSchema(
            { saveId: { type: 'string', pattern: SAVE_ID_PATTERN, description: 'stardew_saves 返回的精确 saveId（不是显示名或路径）。' } },
            ['saveId']
        ),
        annotations: annotations('加载存档', false),
        timeoutMs: 120_000
    },
    {
        name: 'stardew_stop',
        title: '停止当前动作',
        description:
            '优先停止当前游戏动作并释放移动、工具与实时输入。可指定 actionId 只停止该动作。已完成动作的迟到停止不会撤销结果；stop 不会撤销已发生的交易或转移。',
        command: 'stop',
        kind: 'control',
        inputSchema: readSchema(
            {
                actionId: { type: 'string', pattern: ACTION_ID_PATTERN, description: '只停止该动作（可选）。' },
                controlSessionId: { type: 'string', description: '限定控制会话（可选）。' }
            }
        ),
        annotations: annotations('停止当前动作', false),
        modArgs: (args) => (typeof args.actionId === 'string' ? { actionId: args.actionId } : {})
    }
];

export const TOOL_INDEX: ReadonlyMap<string, ToolSpec> = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): ToolSpec | undefined {
    return TOOL_INDEX.get(name);
}

export const TOOL_NAMES: readonly string[] = TOOLS.map((tool) => tool.name);

/** 需要控制会话与动作 ID 的工具（写游戏世界）。 */
export function isWorldWrite(tool: ToolSpec): boolean {
    return tool.kind === 'write';
}

/** 需要在派发前后做资源后验核验的工具。 */
export const RESOURCE_VERIFY_COMMANDS: readonly string[] = [
    'buy', 'ship', 'container', 'craft', 'place', 'eat', 'equip'
];
