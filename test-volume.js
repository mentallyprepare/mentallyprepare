const fs = require('fs');
const dir = '/data/db';
console.log('Checking directory:', dir);
try {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('Created directory:', dir);
  }
  fs.accessSync(dir, fs.constants.W_OK);
  console.log('Directory is writable');
  fs.writeFileSync(dir + '/test.txt', 'hello');
  console.log('File written successfully');
} catch (e) {
  console.error('Error:', e);
}
