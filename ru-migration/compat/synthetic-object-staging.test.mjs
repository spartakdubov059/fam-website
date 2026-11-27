import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stageSyntheticObjects} from './synthetic-object-staging.mjs';

test('stages synthetic files exclusively and removes the partial directory after interruption',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fam-ru-staging-test-'));
 try{
  const objects=[{object_key:'synthetic-one',bytes:Buffer.from('one')},{object_key:'synthetic-two',bytes:Buffer.from('two')}];
  let calls=0;
  await assert.rejects(()=>stageSyntheticObjects(objects,{root,writeObject:async(...args)=>{
   if(++calls===2)throw Error('synthetic extraction interruption');
   return writeFile(...args);
  }}),/synthetic extraction interruption/);
  assert.deepEqual(await readdir(root),[]);
  const dir=await stageSyntheticObjects(objects,{root});
  try{
   assert.deepEqual((await readdir(dir)).sort(),['synthetic-one','synthetic-two']);
   assert.deepEqual(await readFile(join(dir,'synthetic-one')),objects[0].bytes);
  }finally{await rm(dir,{recursive:true,force:true});}
 }finally{await rm(root,{recursive:true,force:true});}
});

test('rejects unsafe object names before writing and cleans the staging directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fam-ru-staging-invalid-'));
 try{
  await assert.rejects(()=>stageSyntheticObjects([{object_key:'../outside',bytes:Buffer.from('x')}],{root}),/INVALID_SYNTHETIC_OBJECT/);
  assert.deepEqual(await readdir(root),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
