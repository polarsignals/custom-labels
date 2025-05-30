const { execSync } = require('child_process');

if (process.platform === 'linux') {
  execSync('node-gyp rebuild', { stdio: 'inherit' });
} else {
  console.log('Skipping native addon build on this platform:', process.platform);
}
