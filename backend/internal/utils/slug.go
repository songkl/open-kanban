package utils

import (
	"regexp"
	"strings"
)

var chineseMap = map[rune]string{
	'项': "xiang", '目': "mu", '开': "kai", '发': "fa", '设': "she", '计': "ji",
	'任': "ren", '务': "wu", '板': "ban", '看': "kan", '协': "xie", '作': "zuo",
	'管': "guan", '理': "li", '文': "wen", '档': "dang", '测': "ce", '试': "shi",
	'修': "xiu", '改': "gai", '完': "wan", '成': "cheng", '中': "zhong", '心': "xin",
	'件': "jian", '数': "shu", '据': "ju", '库': "ku", '问': "wen", '题': "ti",
	'需': "xu", '求': "qiu", '分': "fen", '析': "xi", '部': "bu", '署': "shu",
	'上': "shang", '线': "xian", '布': "bu", '重': "zhong", '要': "yao", '紧': "jin",
	'急': "ji", '优': "you", '先': "xian", '级': "ji", '低': "di", '高': "gao",
	'待': "dai", '审': "shen", '核': "he", '已': "yi", '回': "hui", '复': "fu",
	'通': "tong", '知': "zhi", '日': "ri", '志': "zhi", '记': "ji", '录': "lu",
	'备': "bei", '注': "zhu", '意': "yi", '说': "shuo", '明': "ming", '描': "miao",
	'述': "shu", '概': "gai", '摘': "zhai", '总': "zong", '结': "jie", '划': "hua",
	'情': "qing", '况': "kuang", '度': "du", '阶': "jie", '段': "duan", '环': "huan",
	'境': "jing", '配': "pei", '置': "zhi", '构': "gou", '建': "jian", '模': "mo",
	'块': "kuai", '接': "jie", '口': "kou", '前': "qian", '端': "duan", '后': "hou",
	'移': "yi", '动': "dong", '应': "ying", '用': "yong", '服': "fu", '请': "qing",
	'响': "xiang", '错': "cuo", '误': "wu", '异': "yi", '常': "chang", '失': "shi",
	'败': "bai", '功': "gong", '收': "shou", '送': "song", '入': "ru", '网': "wang",
	'络': "luo", '连': "lian", '断': "duan", '超': "chao", '缓': "huan", '存': "cun",
	'负': "fu", '载': "zai", '均': "jun", '衡': "heng", '监': "jian", '控': "kong",
	'报': "bao", '警': "jing", '跟': "gen", '踪': "zong", '调': "tiao", '化': "hua",
	'命': "ming", '迁': "qian", '份': "fen", '恢': "hui", '还': "huan", '原': "yuan",
	'批': "pi", '准': "zhun", '过': "guo", '拒': "ju", '绝': "jue", '撤': "che",
	'销': "xiao", '放': "fang", '除': "chu", '清': "qing", '归': "gui", '索': "suo",
	'引': "yin", '搜': "sou", '滤': "lv", '排': "pai", '序': "xu", '页': "ye",
	'显': "xian", '示': "shi", '隐': "yin", '藏': "cang", '展': "zhan", '折': "zhe",
	'叠': "die", '悬': "xuan", '停': "ting", '固': "gu", '定': "ding", '浮': "fu",
	'位': "wei", '尺': "chi", '寸': "cun", '宽': "kuan", '边': "bian", '距': "ju",
	'间': "jian", '隔': "ge", '内': "nei", '容': "rong", '框': "kuang", '按': "an",
	'钮': "niu", '图': "tu", '标': "biao", '本': "ben", '输': "shu", '单': "dan",
	'选': "xuan", '多': "duo", '下': "xia", '拉': "la", '菜': "cai", '弹': "tan",
	'出': "chu", '态': "tai", '对': "dui", '话': "hua", '窗': "chuang", '签': "qian",
	'面': "mian", '卡': "ka", '片': "pian", '列': "lie", '表': "biao", '格': "ge",
	'树': "shu", '形': "xing", '导': "dao", '航': "hang", '路': "lu", '径': "jing",
	'包': "bao", '含': "han", '继': "ji", '承': "cheng", '派': "pai", '生': "sheng",
	'封': "feng", '装': "zhuang", '事': "shi", '广': "guang", '播': "bo", '步': "bu",
	'程': "cheng", '池': "chi", '并': "bing", '锁': "suo", '号': "hao", '量': "liang",
	'道': "dao", '流': "liu", '息': "xi", '队': "dui", '栈': "zhan", '堆': "dui",
	'映': "ying", '射': "she", '属': "shu", '性': "xing", '方': "fang", '法': "fa",
	'函': "han", '达': "da", '运': "yun", '算': "suan", '符': "fu", '关': "guan",
	'字': "zi", '串': "chuan", '节': "jie", '编': "bian", '码': "ma", '压': "ya",
	'缩': "suo", '加': "jia", '密': "mi", '权': "quan", '限': "xian", '角': "jiao",
	'色': "se", '户': "hu", '会': "hui", '令': "ling", '牌': "pai", '认': "ren",
	'证': "zheng", '授': "shou", '访': "fang", '黑': "hei", '白': "bai", '防': "fang",
	'火': "huo", '墙': "qiang", '跨': "kua", '域': "yu",
}

var nonChineseRegex = regexp.MustCompile(`[^a-zA-Z0-9]+`)

func ToPinyinSlug(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}

	var result strings.Builder
	for _, char := range name {
		if pinyin, ok := chineseMap[char]; ok {
			result.WriteString(pinyin)
		} else if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' {
			result.WriteRune(char)
		}
	}

	slug := strings.ToLower(result.String())
	slug = nonChineseRegex.ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, "-")
	slug = strings.ReplaceAll(slug, "--", "-")

	return slug
}

func ToBoardAlias(name string) string {
	slug := ToPinyinSlug(name)
	parts := strings.Split(slug, "-")

	var alias strings.Builder
	for _, part := range parts {
		if len(part) > 0 {
			alias.WriteByte(part[0])
		}
	}

	if alias.Len() == 0 {
		alias.WriteString("b")
	}

	return alias.String()
}
