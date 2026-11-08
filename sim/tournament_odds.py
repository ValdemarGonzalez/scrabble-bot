# Monte Carlo of the ScrabbleBot tournament from live OpenSkill ratings.
# Match outcomes follow the Plackett-Luce model the leaderboard itself uses.
import math, random, re, collections, time, sys
random.seed(7)
def rows(path):
    out=[]
    for line in open(path, encoding='utf8'):
        if '|' not in line or line.strip().startswith('-'): continue
        cells=[c.strip() for c in line.split('|')]
        if cells[0] in ('bot_id','id','match_id'): continue
        out.append(cells)
    return out
BETA=25/6; US=196
name={int(i):n.strip('"') for i,n,_ in rows('data/live/bots.txt')}
sim={int(i) for i,_,s in rows('data/live/bots.txt') if s=='true'}
stats={}
for b,mu,sg,n,w,lp in rows('data/live/bot_stats.txt'):
    m=re.search(r'2026-\d\d-\d\d',lp)
    stats[int(b)]=(float(mu),float(sg),int(n),m.group() if m else None)
FRESH=(25.0,25/3,0,None)  # a bot with no rating row yet
class Stats(dict):
    def __missing__(self,k): return FRESH
stats=Stats(stats)
# ---- fit our current strength from tonight's matches (PL maximum likelihood)
matches=collections.defaultdict(list)
for m,b,s in rows('data/live/recent_scores.txt'): matches[int(m)].append((int(b),int(s)))
ours=[ps for m,ps in matches.items() if any(b==US for b,_ in ps) and len(ps)>=5]
def ll_for(x):
    tot=0.0
    for ps in ours:
        ranked=sorted(ps,key=lambda t:-t[1])
        mus=[x if b==US else stats[b][0] for b,_ in ranked]
        sgs=[4.2 if b==US else stats[b][1] for b,_ in ranked]
        c=math.sqrt(sum(s*s+BETA*BETA for s in sgs))
        rest=[mu/c for mu in mus]
        for k in range(len(rest)):
            den=math.log(sum(math.exp(r) for r in rest[k:]))
            tot+=rest[k]-den
    return tot
grid=[30+0.25*i for i in range(161)]
lls=[ll_for(x) for x in grid]
best=max(range(len(grid)),key=lambda i:lls[i]); mu_fit=grid[best]
ci=[grid[i] for i in range(len(grid)) if lls[i]>=lls[best]-1.92]
places=[1+sum(1 for b,s in ps if s>[t for t in ps if t[0]==US][0][1]) for ps in ours]
print(f"our fitted strength: mu {mu_fit:.1f} (95% range {min(ci):.1f}-{max(ci):.1f}) from {len(ours)} matches tonight; avg place {sum(places)/len(places):.2f}; stored rating mu {stats[US][0]:.1f}")
# ---- the field: real bots that played today, with their ratings
field=[b for b,(mu,sg,n,lp) in stats.items() if b not in sim and b!=US and lp and lp>='2026-11-07' and n>=3]
field.sort(key=lambda b:-stats[b][0])
print(f"field: {len(field)} real bots active today. top 10:")
for b in field[:10]: print(f"   {name.get(b,b):22} mu {stats[b][0]:.1f} ±{stats[b][1]:.1f}  matches {stats[b][2]}")
# ---- tournament
def table_sizes(n,size=6):
    tables=max(n//size,1); sizes=[size]*tables
    for i in range(n-size*tables): sizes[i%tables]+=1
    return sizes
def pl_rank(ids,mu,sg):
    c=math.sqrt(sum(sg[i]**2+BETA**2 for i in ids))
    keys={i:mu[i]/c-math.log(-math.log(random.random())) for i in ids}
    return sorted(ids,key=lambda i:-keys[i])
def run(mu_us,n_t=6000,track=False):
    ids=field+[US]; mu={b:stats[b][0] for b in field}; mu[US]=mu_us
    sg={b:stats[b][1] for b in field}; sg[US]=4.2
    res=collections.Counter(); champs=collections.Counter(); pts_sum=0
    for _ in range(n_t):
        pts={i:0 for i in ids}; order=ids[:]; random.shuffle(order)
        for rnd in range(4):
            if rnd>0: order.sort(key=lambda i:(-pts[i],random.random()))
            pos=0
            for size in table_sizes(len(order)):
                table=order[pos:pos+size]; pos+=size
                for place,i in enumerate(pl_rank(table,mu,sg),1): pts[i]+=max(6-place,0)
        cut=sorted(ids,key=lambda i:(-pts[i],random.random()))[:6]
        pts_sum+=pts[US]
        if US in cut: res['cut']+=1
        alive=cut[:]
        while len(alive)>2:
            r=pl_rank(alive,mu,sg); alive=r[:-1]
            if US in alive and len(alive)==3: res['top3']+=1
        if US in alive: res['final']+=1
        a,b=alive; c=math.sqrt(sg[a]**2+sg[b]**2+2*BETA**2)
        pa=math.exp(mu[a]/c)/(math.exp(mu[a]/c)+math.exp(mu[b]/c))
        wins=sum(1 for _ in range(3) if random.random()<pa)
        champ=a if wins>=2 else b
        if champ==US: res['first']+=1
        if track: champs[champ]+=1
    return res,n_t,pts_sum/n_t,champs
t0=time.time()
print(f"\nsimulated tournaments: {len(field)+1} entrants, 4 Swiss rounds, top-6 cut, elimination, best-of-3 final")
print(" our mu   Swiss pts  P(cut)  P(top3)  P(final)  P(1st)")
for label,m in [("fitted",mu_fit),("+2",mu_fit+2),("+4",mu_fit+4),("+6",mu_fit+6),("+8",mu_fit+8),("+10",mu_fit+10),("LUCENT",57.3)]:
    res,n,avgpts,champs=run(m,track=(label=="fitted"))
    print(f" {label:>6} {m:5.1f} {avgpts:8.2f}  {100*res['cut']/n:5.1f}%  {100*res['top3']/n:6.1f}%  {100*res['final']/n:7.1f}%  {100*res['first']/n:6.1f}%")
    if label=="fitted": fav=champs
print(f"\nfavorites for 1st under this model: "+", ".join(f"{name.get(b,b)} {100*c/6000:.0f}%" for b,c in fav.most_common(8)))
print(f"({time.time()-t0:.0f}s)")
