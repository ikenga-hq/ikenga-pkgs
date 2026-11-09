import { shortStoryKeyframesApproved } from './__fixtures__/project.ts';
const p = shortStoryKeyframesApproved();
console.log(p.stages.keyframes, p.shots.length);
console.log(p.bible.characters.map(c=>[c.id,c.name,c.role]));
for (const s of p.shots) console.log(s.id, s.scene, s.refs.join(','), '|', (s.blocking||[]).map(b=>b.who).join(','));
console.log(p.assets.find(a=>a.id==='sc1_sh1_keyframe')!.tags);
