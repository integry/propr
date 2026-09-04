import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const isolatedHome = process.env.PROPR_TEST_OS_HOME;
if (!isolatedHome) throw new Error('PROPR_TEST_OS_HOME is required');
delete process.env.PROPR_TEST_OS_HOME;

const realUserInfo = os.userInfo;
os.userInfo = (...args) => ({ ...realUserInfo(...args), homedir: isolatedHome });
syncBuiltinESMExports();
