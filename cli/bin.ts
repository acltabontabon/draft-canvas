/** The executable: runs one command, prints what it returns and exits with its code. */
import { main } from './main';

void main(process.argv.slice(2)).then(({ code, stdout, stderr }) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
});
