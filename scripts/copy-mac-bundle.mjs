import { spawnSync } from 'node:child_process'
import { lstat, rm } from 'node:fs/promises'

/** APFS clones preserve bundle metadata without allocating a second runtime. */
export async function copyMacBundle(source, destination) {
  try { await lstat(destination); throw new Error(`Bundle destination already exists: ${destination}`) }
  catch(error) { if(error.code!=='ENOENT')throw error }
  const cloned=spawnSync('/bin/cp',['-cRp',source,destination],{encoding:'utf8'})
  if(!cloned.error&&cloned.status===0)return
  // Only discard the new, private staging path created by this copy attempt.
  await rm(destination,{recursive:true,force:true})
  const copied=spawnSync('/usr/bin/ditto',[source,destination],{encoding:'utf8'})
  if(copied.error)throw copied.error
  if(copied.status!==0)throw new Error(`Bundle copy failed: ${copied.stderr}`)
}
