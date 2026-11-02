# -*- coding: utf-8 -*-
"""
自动构建 games.js
数据源（每次运行实时下载）：
  1. RenjuNet 对局库 XML    https://www.renju.net/game/download/xml/
  2. RIF 等级分榜           https://rating.renju.net/  （Top100 排名与等级分）
  3. ljrenju 全历史等级分榜 https://www.ljrenju.com/player/rifwhr2026.htm （中文姓名/省市补充）
用法: python scripts/build_data.py [输出路径，默认 games.js]
"""
import os, re, json, base64, sys, tempfile, urllib.request

XML_URL = 'https://www.renju.net/game/download/xml/'
RATING_URL = 'https://rating.renju.net/'
LJ_URL = 'https://www.ljrenju.com/player/rifwhr2026.htm'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'games.js'

UA = {'User-Agent': 'Mozilla/5.0 (renju-stats builder)'}

def fetch(url, binary=False):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as r:
        data = r.read()
    return data if binary else data.decode('utf-8', errors='replace')

# ---------- 1. RIF 等级分榜（现役+全历史，排名/等级分/中文名/出生年） ----------
print('downloading rating.renju.net ...')
re_tr = re.compile(r'<tr><td class="num">(\d+)</td>(.*?)</tr>', re.S)
re_a = re.compile(r'<a href="player_(\d{6})\.html"[^>]*title="([^"]*)"[^>]*>([^<]+)</a>')
re_td = re.compile(r'<td[^>]*>([^<]*)</td>')

def fetch_rating(url):
    rows = []   # (rank, countryCode, disp, cnTitle, en, rating, countryName, by)
    for tm in re_tr.finditer(fetch(url)):
        rank, body = int(tm.group(1)), tm.group(2)
        am = re_a.search(body)
        if not am: continue
        tds = re_td.findall(body)
        # tds: [rating, ±, gy1, gy2, gy5, country, by]
        rating = int(tds[0]) if tds and tds[0].isdigit() else 0
        country = tds[-2].strip() if len(tds) >= 2 else ''
        by = int(tds[-1]) if tds and tds[-1].isdigit() else 0
        rows.append((rank, '', am.group(1), am.group(2).strip(),
                     am.group(3).strip(), rating, country, by))
    return rows

rat_rows = fetch_rating(RATING_URL)
rat_all_rows = fetch_rating(RATING_URL + 'rating_all.html')
print('rating.renju.net players:', len(rat_rows), ' all-history:', len(rat_all_rows))
rat_rating = {d: rating for _, _, d, _, _, rating, _, _ in rat_rows}
top100 = [d for _, _, d, _, _, _, _, _ in rat_rows[:100]]
top100_set = set(top100)

# ---------- 2. ljrenju 榜（中文国家/省市补充） ----------
print('downloading ljrenju WHR ...')
lj_html = fetch(LJ_URL)
re_row = re.compile(
    r'<tr>\s*<t[dh][^>]*>\s*\d+\s*</t[dh]>\s*<td[^>]*>\s*(\d{6})\s*</td>\s*'
    r'<td[^>]*>\s*([^<(]+?)\s*(?:\(([^)]*)\))?\s*</td>\s*'
    r'<td[^>]*>\s*([^<]*?)\s*</td>\s*<td[^>]*>\s*([^<]*?)\s*</td>\s*'
    r'<td[^>]*>\s*(\d+)\s*</td>', re.I)
lj = {}        # disp_id -> {en, cn, country, city}
for m in re_row.finditer(lj_html):
    disp, en, cn, country, city, _ = m.groups()
    city = city.replace('　', '').strip()
    lj[disp] = {'en': en.strip(), 'cn': (cn or '').strip(),
                'country': country.strip(), 'city': city}
print('ljrenju players:', len(lj))

# ---------- 2. RenjuNet XML（边下边解析太大，先落盘） ----------
print('downloading renjunet xml ...')
xml_bytes = fetch(XML_URL, binary=True)
xml_path = os.path.join(tempfile.gettempdir(), 'renjunet.xml')
with open(xml_path, 'wb') as f:
    f.write(xml_bytes)
print('xml bytes:', len(xml_bytes))

re_player = re.compile(r'<player id="(\d+)" disp_id="(\d+)"')
re_tour = re.compile(r'<tournament id="(\d+)"[^>]*? year="(\d{4})"')
re_rule = re.compile(r'<rule id="(\d+)" name="([^"]*)"')
re_game = re.compile(r'<game id="(\d+)"[^>]*?tournament="(\d+)"[^>]*?rule="(\d+)"[^>]*?black="(\d+)" white="(\d+)" bresult="([\d.]+)"')
re_move = re.compile(r'<move>([^<]*)</move>')
re_coord = re.compile(r'([a-oA-O])(\d{1,2})')

player_disp = {}
tour_year = {}
rules = {}

moves_blob = bytearray()
lens = bytearray()
rule_arr = bytearray()
year_arr = bytearray()
res_arr = bytearray()
black_arr = bytearray()   # u16le
white_arr = bytearray()

cur = None
ngames = 0
maxpid = 0
used_pids = set()
with open(xml_path, encoding='utf-8') as f:
    section = None
    for line in f:
        if section != 'games':
            if '<players>' in line: section = 'players'; continue
            if '</players>' in line: section = None; continue
            if '<rules>' in line: section = 'rules'; continue
            if '</rules>' in line: section = None; continue
            if '<tournaments>' in line: section = 'tours'; continue
            if '</tournaments>' in line: section = None; continue
            if '<games>' in line: section = 'games'; continue
            if section == 'players':
                m = re_player.search(line)
                if m: player_disp[m.group(1)] = m.group(2)
            elif section == 'tours':
                m = re_tour.search(line)
                if m: tour_year[m.group(1)] = int(m.group(2))
            elif section == 'rules':
                m = re_rule.search(line)
                if m: rules[m.group(1)] = m.group(2)
            continue
        m = re_game.search(line)
        if m:
            # 立即登记对局（即便没有棋谱也计入战绩统计）；棋谱在随后的 <move> 行补上
            tour, rule, black, white, bres = m.group(2), m.group(3), m.group(4), m.group(5), m.group(6)
            bd = player_disp.get(black, '')
            wd = player_disp.get(white, '')
            is_top = (bd in top100_set) or (wd in top100_set)
            r = 2 if bres == '0.5' else (0 if bres == '1' else 1)
            if is_top: r += 4
            lens.append(0)
            rule_arr.append(int(rule))
            year_arr.append(max(0, min(255, tour_year.get(tour, 0) - 1900)))
            res_arr.append(r)
            bi, wi = int(black), int(white)
            maxpid = max(maxpid, bi, wi)
            used_pids.add(bi); used_pids.add(wi)
            black_arr += bi.to_bytes(2, 'little')
            white_arr += wi.to_bytes(2, 'little')
            cur = ngames   # 当前局的下标
            ngames += 1
            continue
        m = re_move.search(line)
        if m and cur is not None:
            cells = []
            ok = True
            for col_ch, row_s in re_coord.findall(m.group(1)):
                col = ord(col_ch.lower()) - 97
                row_top = 15 - int(row_s)
                if not (0 <= col <= 14 and 0 <= row_top <= 14): ok = False; break
                cells.append(row_top * 15 + col)
            if ok and cells:
                moves_blob.extend(cells)
                lens[cur] = len(cells)
            cur = None

print('games:', ngames, 'with moves:', sum(1 for L in lens if L > 0), 'maxpid:', maxpid)

# ---------- 选手姓名表（pid -> "中文|English"，仅保留出现在对局中的选手） ----------
name_by_disp = {}
for d, info in lj.items():
    if info['en']:
        name_by_disp[d] = (info['cn'] + '|' + info['en']) if info['cn'] else info['en']
for rows in (rat_rows, rat_all_rows):
    for _r, _c, disp, cn_title, en, _rt, _co, _by in rows:
        if disp not in name_by_disp:
            name_by_disp[disp] = (cn_title + '|' + en) if cn_title else en
pname = {}
for pid in used_pids:
    nm = name_by_disp.get(player_disp.get(str(pid), ''), '')
    if nm: pname[str(pid)] = nm
print('named players:', len(pname), '/', len(used_pids))

def build_players(rows):
    out = []
    for rank, _cc, disp, cn_title, en, rating, country_en, by in rows[:100]:
        info = lj.get(disp, {})
        out.append({
            'rank': rank, 'disp': disp,
            'en': en, 'cn': info.get('cn') or cn_title,
            'country': info.get('country') or country_en,
            'city': info.get('city', ''),
            'rating': rating, 'by': by,
        })
    return out

players = build_players(rat_rows)
players_all = build_players(rat_all_rows)

def b64(b): return base64.b64encode(bytes(b)).decode('ascii')

out = {
    'source': 'renju.net game database; ljrenju.com rifwhr2026',
    'rules': rules,
    'counts': {
        # all/top100 用于分支树的「统计范围」显示，只计有棋谱的对局
        'all': sum(1 for L in lens if L > 0),
        'top100': sum(1 for i, L in enumerate(lens) if L > 0 and res_arr[i] >= 4),
        # totalAll/totalTop100 含无棋谱对局（战绩统计口径）
        'totalAll': ngames,
        'totalTop100': sum(1 for r in res_arr if r >= 4),
    },
    'top100': players,
    'top100All': players_all,
    'pname': pname,
    'moves': b64(moves_blob),
    'lens': b64(lens),
    'rule': b64(rule_arr),
    'year': b64(year_arr),
    'res': b64(res_arr),
    'black': b64(black_arr),
    'white': b64(white_arr),
}
# disp_id -> 内部id 映射（用于把 top100 映射到每局的 black/white id）
out['pidByDisp'] = {d: int(pid) for pid, d in player_disp.items() if d in top100_set}
# 内部id -> RIF 等级分（rating.renju.net 现役榜上所有选手，用于对手分级统计）
out['ratingByPid'] = {int(pid): rat_rating[d] for pid, d in player_disp.items() if d in rat_rating}
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('window.RENJU_GAMES = ')
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    f.write(';')
print('written', OUT, os.path.getsize(OUT))
