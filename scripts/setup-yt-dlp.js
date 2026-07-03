const { execFileSync } = require('child_process');

const checkCommands = process.platform === 'win32'
  ? [
      ['yt-dlp', ['--version']],
      ['py', ['-3', '-m', 'yt_dlp', '--version']],
      ['python', ['-m', 'yt_dlp', '--version']]
    ]
  : [
      ['yt-dlp', ['--version']],
      ['python3', ['-m', 'yt_dlp', '--version']],
      ['python', ['-m', 'yt_dlp', '--version']]
    ];

function commandWorks(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (checkCommands.some(([command, args]) => commandWorks(command, args))) {
  process.exit(0);
}

const installCommands = process.platform === 'win32'
  ? [
      ['py', ['-3', '-m', 'pip', 'install', 'yt-dlp']],
      ['python', ['-m', 'pip', 'install', 'yt-dlp']]
    ]
  : [
      ['python3', ['-m', 'pip', 'install', 'yt-dlp']],
      ['python', ['-m', 'pip', 'install', 'yt-dlp']]
    ];

for (const [command, args] of installCommands) {
  try {
    execFileSync(command, args, { stdio: 'inherit' });
    process.exit(0);
  } catch {
    // Try the next available Python command.
  }
}

console.warn('yt-dlp was not found and could not be installed automatically. Install it with pip manually.');
process.exit(0);