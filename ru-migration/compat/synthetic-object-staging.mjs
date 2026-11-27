import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Fixed synthetic archive staging. A failed extraction removes its partial directory.
export async function stageSyntheticObjects(objects,{root=tmpdir(),writeObject=writeFile}={}){
 if(!Array.isArray(objects)||typeof writeObject!=='function')throw new TypeError('synthetic objects and writer are required');
 const dir=await mkdtemp(join(root,'fam-ru-disposable-media-'));
 try{
  for(const object of objects){
   if(!object||typeof object.object_key!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(object.object_key)
      ||!Buffer.isBuffer(object.bytes))throw Error('INVALID_SYNTHETIC_OBJECT');
   await writeObject(join(dir,object.object_key),object.bytes,{mode:0o600,flag:'wx'});
  }
  return dir;
 }catch(error){
  await rm(dir,{recursive:true,force:true});
  throw error;
 }
}
