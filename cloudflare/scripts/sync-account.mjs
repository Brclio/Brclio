import {copyFile} from 'node:fs/promises';

// Bundle exactly the same account interface into the website and native clients.
for (const [source, destination] of [['account.js', 'account-client.txt'], ['account.css', 'account-style.txt']]) {
  await copyFile(new URL(`../../web/${source}`, import.meta.url), new URL(`../src/${destination}`, import.meta.url));
}
