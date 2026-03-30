const chineseMap: Record<string, string> = {
  '项': 'xiang', '目': 'mu', '开': 'kai', '发': 'fa', '设': 'she', '计': 'ji',
  '任': 'ren', '务': 'wu', '板': 'ban', '看': 'kan', '协': 'xie', '作': 'zuo',
  '管': 'guan', '理': 'li', '文': 'wen', '档': 'dang', '测': 'ce', '试': 'shi',
  '修': 'xiu', '改': 'gai', '完': 'wan', '成': 'cheng', '中': 'zhong', '心': 'xin',
  '件': 'jian', '数': 'shu', '据': 'ju', '库': 'ku',
};

export function toEnglishSlug(str: string): string {
  let result = '';
  for (const char of str) {
    if (chineseMap[char]) {
      result += chineseMap[char];
    } else if (/[a-zA-Z0-9]/.test(char)) {
      result += char.toLowerCase();
    }
  }
  
  if (!result) {
    result = 'board';
  }
  
  return result.replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').replace(/\//g, '-');
}
