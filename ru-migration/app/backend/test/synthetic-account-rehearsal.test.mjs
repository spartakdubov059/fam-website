import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySyntheticAccountRehearsal } from '../../../compat/verify-synthetic-account-rehearsal.mjs';

const a = {user_id:'synthetic-a',school_id:'synthetic-school',role:'student',active:true};
const b = {user_id:'synthetic-b',school_id:'synthetic-school',role:'school_admin',active:false};
const ta = {...a,issuer:'https://synthetic.invalid',subject:'synthetic-y-a'};
const tb = {...b,issuer:'https://synthetic.invalid',subject:'synthetic-y-b'};

const cases = [
  ['preserves identifiers and status regardless of row order',[a,b],[tb,ta],'SYNTHETIC_PROFILE_REHEARSAL_PASS'],
  ['detects missing account',[a,b],[ta],'MISSING_TARGET_ACCOUNT'],
  ['rejects duplicate source identifier',[a,a],[ta],'DUPLICATE_SOURCE_ID'],
  ['rejects duplicate target identifier',[a,b],[ta,ta],'DUPLICATE_TARGET_ID'],
  ['rejects duplicate provider subject',[a,b],[ta,{...tb,subject:ta.subject}],'DUPLICATE_TARGET_IDENTITY'],
  ['rejects school changes',[a,b],[ta,{...tb,school_id:'synthetic-other'}],'PROFILE_INVARIANT_CHANGED'],
  ['rejects role changes',[a,b],[ta,{...tb,role:'student'}],'PROFILE_INVARIANT_CHANGED'],
  ['rejects activation of inactive profile',[a,b],[ta,{...tb,active:true}],'PROFILE_INVARIANT_CHANGED'],
  ['rejects unexpected target account',[a,b],[ta,{...tb,user_id:'synthetic-c'}],'UNEXPECTED_TARGET_ACCOUNT'],
  ['rejects extra source fields',[{...a,email:'synthetic@example.invalid'}],[ta],'INVALID_SYNTHETIC_SOURCE'],
  ['rejects real provider issuer',[a],[{...ta,issuer:'https://login.yandex.ru'}],'INVALID_SYNTHETIC_TARGET'],
  ['rejects empty rehearsal',[],[],'INVALID_MANIFEST']
];

for (const [name,source,target,code] of cases) {
  test(name, () => {
    const result = verifySyntheticAccountRehearsal(source,target);
    assert.equal(result.code,code);
    assert.equal(result.ok,code === 'SYNTHETIC_PROFILE_REHEARSAL_PASS');
    if (result.ok) assert.equal(result.count,source.length);
    else assert.deepEqual(Object.keys(result).sort(),['code','ok']);
  });
}
