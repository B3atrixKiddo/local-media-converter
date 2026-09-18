import { mkdir, copyFile, rm, readFile } from 'node:fs/promises'

const src = 'node_modules/@ffmpeg/core/dist/esm'
const dest = 'public/ffmpeg'

await rm(dest, { recursive: true, force: true })
await mkdir(dest, { recursive: true })

for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await copyFile(`${src}/${f}`, `${dest}/${f}`)
}

const js = await readFile(`${dest}/ffmpeg-core.js`, 'utf8')
if (!js.includes('export default createFFmpegCore')) {
  console.error('\nWRONG BUILD: copied core has no default export. Check that', src, 'is the esm folder.\n')
  process.exit(1)
}

console.log('ffmpeg esm core ready in', dest)