// Starts mongodb/mongodb-atlas-local (mongod + mongot: Search and Vector Search) for the Atlas arm,
// then waits for the image's own healthcheck to report "healthy" (polls; never a fixed sleep).
//   node scripts/atlas-local.mjs up
// Remove it later with: docker rm -f mug-atlas-local
import { execFileSync } from 'node:child_process';

const NAME = process.env.ATLAS_LOCAL_CONTAINER ?? 'mug-atlas-local';
const IMAGE = process.env.ATLAS_LOCAL_IMAGE ?? 'mongodb/mongodb-atlas-local:9.0.4';
const PORT = process.env.ATLAS_LOCAL_PORT ?? '27018';

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const status = () => {
  try {
    return docker('inspect', '-f', '{{.State.Status}} {{.State.Health.Status}}', NAME);
  } catch {
    return 'missing';
  }
};

if (process.argv[2] !== 'up') {
  console.error('usage: node scripts/atlas-local.mjs up');
  process.exit(2);
}

const s = status();
if (s === 'missing') {
  docker('run', '-d', '--name', NAME, '-p', `${PORT}:27017`, IMAGE);
  console.log(`started ${NAME} from ${IMAGE}`);
} else if (!s.startsWith('running')) {
  docker('start', NAME);
  console.log(`restarted ${NAME}`);
}

const deadline = Date.now() + 180_000;
for (;;) {
  const health = status().split(' ')[1];
  if (health === 'healthy') break;
  if (health === 'unhealthy' || Date.now() > deadline) {
    console.error(`${NAME} is ${health ?? 'not running'}; see: docker logs ${NAME}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(
  `${NAME} is healthy. ATLAS_LOCAL_URI=mongodb://127.0.0.1:${PORT}/?directConnection=true`,
);
