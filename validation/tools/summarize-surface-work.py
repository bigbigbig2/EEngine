from pathlib import Path
import json,math,re,statistics,sys,csv
root=Path(__file__).resolve().parents[2]; folder=root/(sys.argv[1] if len(sys.argv)>1 else '.local/validation/surface-v3-work-bandwidth-final')
def stat(values):
 v=sorted(values)
 return {'p50':v[max(0,math.ceil(len(v)*.5)-1)],'p95':v[max(0,math.ceil(len(v)*.95)-1)],'min':v[0],'max':v[-1],'mean':statistics.mean(v),'count':len(v)}
def group(label):
 label=label.removeprefix('Renderer/visibility-frame/')
 if re.search(r'^SurfaceWork/',label):return 'Surface work classify/finalize'
 if re.search(r'^Surface/(?:view epoch|input witness)',label):return 'Surface input witness'
 if re.search(r'^Surface/GeometryRecord',label):return 'Surface geometry'
 if re.search(r'^Surface/(?:residency epoch|material publication lookup)',label):return 'Material lookup'
 if re.search(r'^Surface/material miss (?:indirect finalize|queue compact)',label):return 'Material scheduling'
 if re.search(r'^Surface/material (?:publication kernel|miss publication evaluation)',label):return 'Material evaluate'
 if re.search(r'^Surface/lighting ',label):return 'Lighting'
 if re.search(r'^Surface/reconstruct',label):return 'Reconstruct'
 if label.startswith('FSR3'):return 'FSR3'
 if label.startswith('XeGTAO'):return 'XeGTAO'
 if re.search(r'VSM|Shadow',label,re.I):return 'VSM'
 if re.search(r'^(R3-|S1 |Geometry/|Raster partitions/|HZB/)',label):return 'Visibility (inclusive)'
 if re.search(r'diagnostics|counter',label,re.I):return 'Diagnostics'
 return 'Other'
surfacegroups={'Surface work classify/finalize','Surface input witness','Surface geometry','Material lookup','Material scheduling','Material evaluate','Lighting','Reconstruct'}
result={'definition':{'MB':'10^6 bytes','bandwidth':'logical source writes / format-footprint reads, not physical DRAM','implicit':'empty only; no nonempty implicit tile path','visibility':'hierarchy + meshlet + frame geometry + raster partitions + raster + HZB'},'cases':{},'labels':{}}
for p in folder.glob('0-*.json'):
 if 'failure' in p.stem:continue
 r=json.loads(p.read_text(encoding='utf-8'));frames=r['frames'];third=len(frames)//3;motion=r['request'].get('trajectory')=='orbit-return'
 for phase,rows in ([('static',frames[:third]),('moving',frames[third:2*third]),('recovered',frames[2*third:])] if motion else [('static',frames)]):
  counters={};timings={};frameRows=[]
  for f in rows:
   values=f.get('surfaceDiagnostics',{}).get('values')
   if values:
    v=dict(values)
    v['mixedSamples']=v['sampleAccepted']-v['uniformTiles']
    v['sampleScreenPercent']=100*v['sampleAccepted']/v['outputPixels'];v['sampleVisiblePercent']=100*v['sampleAccepted']/v['visiblePixels']
    v['mixedSamplePercent']=100*v['mixedSamples']/v['sampleAccepted']
    v['geometryHitPercent']=100*v['geometryCacheHit']/v['sampleAccepted'];v['materialHitPercent']=100*v['materialHit']/v['sampleAccepted']
    v['packetWrites']=sum(v[k+'PacketWrites'] for k in ['diffuse','specular','coat','ibl'])
    v['nonemptyImplicitTiles']=0
    # Independent reconciliation checks; reject a misleading byte ledger.
    assert v['sampleOverflow']==0 and v['queueOverflowFlags']==0
    assert v['reconstructMappedPixels']==v['visiblePixels']
    assert v['geometryRecordWriteBytes']==36*v['geometryCacheHit']+192*v['geometryMissCompleted'],p
    assert v['packetWriteBytes']==16*v['packetWrites']
    assert v['reconstructReadBytes']==52*v['outputPixels']+64*v['reconstructOutputPixels']+8*v['reconstructHistoryLoads']
    assert f['surfaceDiagnostics']['coverage']['status']=='pass'
    for k,x in v.items():counters.setdefault(k,[]).append(x)
   totals={};segments=f['gpu']['segments']
   for seg in segments:
    g=group(seg['label']);result['labels'][seg['label']]=g;totals[g]=totals.get(g,0)+seg['durationMs']
   totals['Surface total']=sum(totals.get(g,0) for g in surfacegroups)
   totals['Visibility raster']=sum(x['durationMs'] for x in segments if x['label'].endswith('Geometry/partitioned compiled coverage'))
   totals['Frame pass sum']=sum(x['durationMs'] for x in segments)
   ticks=[(int(s['startTick']),int(s['endTick'])) for s in segments]
   totals['Frame GPU span']=(max(x[1] for x in ticks)-min(x[0] for x in ticks))/1e6
   for g in {*surfacegroups,'Visibility (inclusive)','Visibility raster','FSR3','VSM','XeGTAO','Other','Diagnostics','Surface total','Frame pass sum','Frame GPU span'}:timings.setdefault(g,[]).append(totals.get(g,0))
   frameRows.append({'frame':f['frameIndex'],'gpuMs':totals,'counters':values})
  result['cases'][p.stem+'-'+phase]={'counters':{k:stat(v) for k,v in counters.items()},'gpuMs':{k:stat(v) for k,v in timings.items()},'conditions':r['conditions'],'issues':r['issues'],'frames':frameRows}
(folder/'work-ledger.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
flat=[]
for name,case in result['cases'].items():
 for frame in case['frames']:
  flat.append({'case':name,'frame':frame['frame'],'vsmEnabled':case['conditions']['features']['vsm'],
    **{'gpuMs/'+k:v for k,v in frame['gpuMs'].items()},**{'counter/'+k:v for k,v in (frame['counters'] or {}).items()}})
with (folder/'per-frame.csv').open('w',encoding='utf-8-sig',newline='') as file:
 writer=csv.DictWriter(file,fieldnames=list(dict.fromkeys(k for row in flat for k in row)))
 writer.writeheader();writer.writerows(flat)
columns=[(cov,phase) for cov in ['low','high'] for phase in ['static','moving','recovered']]
def table(keys,kind):
 text='| 指标 | 低覆盖静止 | 低覆盖移动 | 低覆盖恢复 | 高覆盖静止 | 高覆盖移动 | 高覆盖恢复 |\n|---|---:|---:|---:|---:|---:|---:|\n'
 for key,label,scale,fmt in keys:
  cells=[]
  for cov,phase in columns:
   mode='detailed' if kind=='counters' else 'timing'
   c=result['cases'].get(f'0-{cov}-{mode}-{phase}',{}).get(kind,{}).get(key)
   if not c:cells.append('—');continue
   if key=='VSM':cells.append('关闭');continue
   x=c['p50']/scale
   cells.append((f'{x:.2f} / {c["p95"]/scale:.2f}' if fmt=='pair' else f'{x:,.0f}' if fmt=='int' else f'{x:.2f}'))
  text+='| '+label+' | '+' | '.join(cells)+' |\n'
 return text
counts=[(x,x,1,'int') for x in ['visiblePixels','emptyTiles','nonemptyImplicitTiles','uniformTiles','mixedTiles','sampleAccepted','mixedSamples']]
counts += [(x,x,1,'float') for x in ['sampleScreenPercent','sampleVisiblePercent','mixedSamplePercent']]
counts += [(x,x,1,'int') for x in ['geometryCacheHit','geometryMissCompleted','materialHit','materialMissQueued','diffuseEvaluations','specularEvaluations','coatEvaluations','iblEvaluations','diffusePacketWrites','specularPacketWrites','coatPacketWrites','iblPacketWrites']]
byteskeys=[(x,x+' (MB)',1e6,'float') for x in ['geometryRecordWriteBytes','packetWriteBytes','reconstructReadBytes','reconstructWriteBytes']]
stages=[(x,x+' P50/P95 (ms)',1,'pair') for x in ['Visibility (inclusive)','Visibility raster','Surface work classify/finalize','Surface input witness','Surface geometry','Material lookup','Material scheduling','Material evaluate','Lighting','Reconstruct','Surface total','FSR3','VSM','XeGTAO','Other','Diagnostics','Frame pass sum','Frame GPU span']]
text='# Surface V3 实际工作量和逻辑字节账本\n\n1920×1080，2,073,600 pixels，8×8 tile 共 32,400。逐列统计 40 帧，计数取 detailed，GPU 时间取独立 timing，单位为每帧。P50/P95 从每帧阶段总和计算；列间 P50 不能简单相加。\n\n'+table(counts,'counters')+'\n'+table(byteskeys,'counters')+'\n'+table(stages,'gpuMs')
(folder/'work-ledger.md').write_text(text,encoding='utf-8')
print(text)
