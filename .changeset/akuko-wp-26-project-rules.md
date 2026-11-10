---
"@ikenga/skill-akuko": minor
---

akuko: house rules are now enforced. When a project has `rules`, every job from the bible, key-frame, motion and sound stages is checked before the spend gate. Banned words (whole words, any case, with exceptions such as a fabric name), required text (by shot, scene or part, with exemptions such as reference shots skipping the house style) and, for paid jobs, every reference file by its content hash: a file akuko did not generate is sent only if its sha256 is on the allow-list, only for the entries it is allowed for, and never for a character marked never-from-photo. A breach is refused as `rules-breach`, naming the rule and the offending text or file, and nothing is priced, sent or spent. New `rules/cli.ts check --project <folder>` lists every breach in the project for free, and `rules/cli.ts hash <file>` prints the hash an allow-list entry takes. Doctor reports the rules status and allowed files it can't find.
