/** Zip a pack folder for upload on the home page:  npm run pack:zip -- packs/<id>   → packs/<id>.zip */
import path from 'node:path';
import fs from 'node:fs';
import AdmZip from 'adm-zip';

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, 'pack.json'))) {
  console.error('Використання: npm run pack:zip -- packs/<id>');
  process.exit(2);
}
const zip = new AdmZip();
zip.addLocalFolder(dir, path.basename(dir));
const out = `${dir.replace(/[\/]+$/, '')}.zip`;
zip.writeZip(out);
console.log(`✓ ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} МБ) — завантажте його на головній сторінці гри`);
