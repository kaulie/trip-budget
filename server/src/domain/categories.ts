import type { Category } from './types.js';

/**
 * Built-in categories. Deliberately data (not an enum baked into the UI): the
 * client renders whatever `GET /ledgers/:id/categories` returns, and a ledger
 * can add its own rows later without a migration.
 *
 * `icon` is an SF Symbol name so the iOS client can render it directly.
 * `keywords` are also used by the offline rule-based agent parser.
 */
export interface BuiltinCategory extends Omit<Category, 'id' | 'ledgerId' | 'isArchived'> {
  keywords: string[];
}

export const BUILTIN_CATEGORIES: BuiltinCategory[] = [
  {
    key: 'food',
    name: '吃饭',
    icon: 'fork.knife',
    kind: 'expense',
    sortOrder: 10,
    keywords: [
      '吃饭', '晚饭', '午饭', '早饭', '早餐', '午餐', '晚餐', '夜宵', '宵夜', '聚餐',
      '火锅', '烧烤', '外卖', '咖啡', '奶茶', '饮料', '喝酒', '酒吧', '零食', '水果',
      '餐', '饭', '吃', '喝', '串', '面', '菜', '食堂', '麦当劳', '肯德基', '星巴克',
    ],
  },
  {
    key: 'transport',
    name: '交通',
    icon: 'car.fill',
    kind: 'expense',
    sortOrder: 20,
    keywords: [
      '交通', '打车', '出租车', '地铁', '公交', '高铁', '火车', '飞机', '机票', '油费',
      '加油', '停车', '过路费', '船票', '大巴', '滴滴', '共享单车', '单车', 'uber',
    ],
  },
  {
    key: 'entertainment',
    name: '门票/娱乐',
    icon: 'ticket.fill',
    kind: 'expense',
    sortOrder: 30,
    keywords: [
      '门票', '景区', '景点', '博物馆', '演出', '话剧', '音乐节', '演唱会', '电影',
      'KTV', '游戏', '游乐场', '温泉', '滑雪', '潜水', '活动', '娱乐',
    ],
  },
  {
    key: 'lodging',
    name: '住宿',
    icon: 'bed.double.fill',
    kind: 'expense',
    sortOrder: 40,
    keywords: [
      '住宿', '酒店', '民宿', '旅馆', '宾馆', '客栈', '青旅', '房费', 'airbnb', '订房', '住',
    ],
  },
  {
    key: 'shopping',
    name: '购物',
    icon: 'bag.fill',
    kind: 'expense',
    sortOrder: 50,
    keywords: [
      '购物', '买东西', '买', '衣服', '鞋', '化妆品', '护肤', '数码', '耳机', '礼品',
      '纪念品', '伴手礼', '免税', '奥特莱斯', '超市',
    ],
  },
  {
    key: 'daily',
    name: '日常生活',
    icon: 'house.fill',
    kind: 'expense',
    sortOrder: 60,
    keywords: ['日常', '生活', '水电', '房租', '物业', '话费', '网费', '快递', '日用', '家政'],
  },
  {
    key: 'medical',
    name: '医疗',
    icon: 'cross.case.fill',
    kind: 'expense',
    sortOrder: 70,
    keywords: ['医疗', '看病', '买药', '药', '医院', '挂号', '体检', '牙医', '疫苗', '保健'],
  },
  {
    key: 'education',
    name: '教育',
    icon: 'book.fill',
    kind: 'expense',
    sortOrder: 80,
    keywords: ['教育', '学费', '培训', '课程', '书', '买书', '考试', '报名费', '网课'],
  },
  {
    key: 'salary',
    name: '工资/收入',
    icon: 'banknote.fill',
    kind: 'income',
    sortOrder: 90,
    keywords: ['工资', '收入', '奖金', '报销', '退款', '利息', '分红', '发了', '红包', '赚'],
  },
  {
    key: 'other',
    name: '其他',
    icon: 'ellipsis.circle.fill',
    kind: 'both',
    sortOrder: 1000,
    keywords: [],
  },
];

export const DEFAULT_CATEGORY_KEY = 'other';

const BY_KEY = new Map(BUILTIN_CATEGORIES.map((c) => [c.key, c]));

export function builtinCategory(key: string): BuiltinCategory | undefined {
  return BY_KEY.get(key);
}

export function isKnownCategoryKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** Pick the highest scoring category by keyword hit; `other` when nothing matches. */
export function guessCategoryFromText(text: string): string {
  const haystack = text.toLowerCase();
  let best: { key: string; score: number; length: number } | null = null;
  for (const category of BUILTIN_CATEGORIES) {
    for (const keyword of category.keywords) {
      if (!haystack.includes(keyword.toLowerCase())) continue;
      const score = keyword.length;
      if (
        best === null ||
        score > best.score ||
        (score === best.score && keyword.length > best.length) ||
        (score === best.score && keyword.length === best.length && category.sortOrder < (BY_KEY.get(best.key)?.sortOrder ?? 0))
      ) {
        best = { key: category.key, score, length: keyword.length };
      }
    }
  }
  return best?.key ?? DEFAULT_CATEGORY_KEY;
}
