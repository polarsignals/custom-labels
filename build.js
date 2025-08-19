const { execSync } = require('child_process');

if (process.platform === 'linux') {
  execSync('node-gyp rebuild --verbose', { stdio: 'inherit' });
} else {
  execSync('node-gyp rebuild --verbose', { stdio: 'inherit' });
}
