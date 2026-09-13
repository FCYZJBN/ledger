// 种子数据：首次打开时预置默认分类和账户标签
import { categories, accounts } from './db.js';

function cat(id, name, type, parentId, icon, color) {
  return { id, name, type, parentId, icon, color };
}

// 支出两级分类
const EXPENSE = [
  cat('p-food', '餐饮', 'expense', null, '🍜', '#FF7043'),
  cat('c-food-breakfast', '早餐', 'expense', 'p-food', '🥛', '#FF7043'),
  cat('c-food-lunch', '午餐', 'expense', 'p-food', '🍱', '#FF7043'),
  cat('c-food-dinner', '晚餐', 'expense', 'p-food', '🍲', '#FF7043'),
  cat('c-food-takeout', '外卖', 'expense', 'p-food', '🥡', '#FF7043'),
  cat('c-food-milktea', '奶茶', 'expense', 'p-food', '🧋', '#FF7043'),
  cat('c-food-snacks', '零食', 'expense', 'p-food', '🍿', '#FF7043'),

  cat('p-transport', '交通', 'expense', null, '🚌', '#42A5F5'),
  cat('c-transport-metro', '地铁', 'expense', 'p-transport', '🚇', '#42A5F5'),
  cat('c-transport-bus', '公交', 'expense', 'p-transport', '🚌', '#42A5F5'),
  cat('c-transport-taxi', '打车', 'expense', 'p-transport', '🚕', '#42A5F5'),
  cat('c-transport-fuel', '加油', 'expense', 'p-transport', '⛽', '#42A5F5'),
  cat('c-transport-parking', '停车', 'expense', 'p-transport', '🅿️', '#42A5F5'),

  cat('p-shopping', '购物', 'expense', null, '🛍️', '#EC407A'),
  cat('c-shopping-daily', '日用品', 'expense', 'p-shopping', '🧻', '#EC407A'),
  cat('c-shopping-clothes', '衣服', 'expense', 'p-shopping', '👕', '#EC407A'),
  cat('c-shopping-digital', '数码', 'expense', 'p-shopping', '📱', '#EC407A'),
  cat('c-shopping-beauty', '美妆', 'expense', 'p-shopping', '💄', '#EC407A'),

  cat('p-fun', '娱乐', 'expense', null, '🎮', '#AB47BC'),
  cat('c-fun-movie', '电影', 'expense', 'p-fun', '🎬', '#AB47BC'),
  cat('c-fun-game', '游戏', 'expense', 'p-fun', '🎮', '#AB47BC'),
  cat('c-fun-travel', '旅游', 'expense', 'p-fun', '✈️', '#AB47BC'),
  cat('c-fun-sport', '运动', 'expense', 'p-fun', '⚽', '#AB47BC'),

  cat('p-home', '居住', 'expense', null, '🏠', '#26A69A'),
  cat('c-home-rent', '房租', 'expense', 'p-home', '🏠', '#26A69A'),
  cat('c-home-utility', '水电', 'expense', 'p-home', '💡', '#26A69A'),
  cat('c-home-property', '物业', 'expense', 'p-home', '🏢', '#26A69A'),
  cat('c-home-furnishing', '家居', 'expense', 'p-home', '🛋️', '#26A69A'),

  cat('p-health', '医疗', 'expense', null, '💊', '#EF5350'),
  cat('c-health-medicine', '药品', 'expense', 'p-health', '💊', '#EF5350'),
  cat('c-health-clinic', '门诊', 'expense', 'p-health', '🏥', '#EF5350'),
  cat('c-health-checkup', '体检', 'expense', 'p-health', '🩺', '#EF5350'),

  cat('p-social', '人情', 'expense', null, '🎁', '#FFA726'),
  cat('c-social-redpacket', '红包', 'expense', 'p-social', '🧧', '#FFA726'),
  cat('c-social-gift', '送礼', 'expense', 'p-social', '🎁', '#FFA726'),
  cat('c-social-treat', '请客', 'expense', 'p-social', '🍻', '#FFA726'),

  cat('p-study', '学习', 'expense', null, '📚', '#66BB6A'),
  cat('c-study-book', '书籍', 'expense', 'p-study', '📖', '#66BB6A'),
  cat('c-study-course', '课程', 'expense', 'p-study', '🎓', '#66BB6A'),
  cat('c-study-exam', '考试', 'expense', 'p-study', '📝', '#66BB6A'),

  cat('p-other', '其他', 'expense', null, '📦', '#90A4AE'),
];

// 收入两级分类
const INCOME = [
  cat('p-income-salary', '工资', 'income', null, '💰', '#26C6DA'),
  cat('c-income-salary-month', '月薪', 'income', 'p-income-salary', '💰', '#26C6DA'),
  cat('c-income-salary-bonus', '年终奖', 'income', 'p-income-salary', '🏆', '#26C6DA'),

  cat('p-income-parttime', '兼职', 'income', null, '💼', '#7E57C2'),
  cat('p-income-redpacket', '红包', 'income', null, '🧧', '#EF5350'),
  cat('p-income-invest', '理财', 'income', null, '📈', '#4DB6AC'),
  cat('p-income-other', '其他收入', 'income', null, '💵', '#90A4AE'),
];

const DEFAULT_CATEGORIES = [...EXPENSE, ...INCOME].map((c, i) => ({
  ...c,
  sortOrder: i,
}));

const DEFAULT_ACCOUNTS = [
  { id: 'acct-wechat', name: '微信', icon: '💬', color: '#07C160' },
  { id: 'acct-alipay', name: '支付宝', icon: '🔷', color: '#1677FF' },
  { id: 'acct-cash', name: '现金', icon: '💵', color: '#8D6E63' },
  { id: 'acct-bank', name: '银行卡', icon: '🏦', color: '#546E7A' },
  { id: 'acct-credit', name: '信用卡', icon: '💳', color: '#7E57C2' },
].map((a, i) => ({ ...a, sortOrder: i }));

// 首次打开时若为空则写入种子数据
export async function ensureSeeded() {
  const [existingCats, existingAccts] = await Promise.all([
    categories.all(),
    accounts.all(),
  ]);
  if (existingCats.length === 0) {
    await categories.bulkAdd(DEFAULT_CATEGORIES);
  }
  if (existingAccts.length === 0) {
    await accounts.bulkAdd(DEFAULT_ACCOUNTS);
  }
}
