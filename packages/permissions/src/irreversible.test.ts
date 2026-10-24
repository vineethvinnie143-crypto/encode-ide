import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hardToUndo, type UndoContext } from './irreversible'

const posix: UndoContext = { root: '/work/app', cwd: '/work/app', home: '/home/dev', dialect: 'bash', platform: 'posix' }
const pwsh: UndoContext = { root: 'C:\\work\\app', cwd: 'C:\\work\\app', home: 'C:\\Users\\dev', dialect: 'pwsh', platform: 'win32' }
const of = (line: string, context = posix) => hardToUndo(line, context)

describe('hard-to-undo commands', () => {
  it('are recursive deletes, deletes outside the project and shred, not what a build makes again', () => {
    assert.equal(of('rm -rf src'), 'deletes src and everything in it')
    assert.equal(of('cd packages && rm -r core'), 'deletes packages/core and everything in it')
    assert.equal(of('rm -rf .git'), 'deletes .git and everything in it')
    assert.equal(of('rm -rf ./'), 'deletes the whole project and everything in it')
    assert.equal(of('rm ~/.bashrc'), 'deletes /home/dev/.bashrc, outside the project')
    assert.equal(of('rm -rf "$TARGET"'), 'deletes a folder only known when the line runs, and everything in it')
    assert.equal(of('find . -name "*.orig" -delete'), 'deletes every file find matches')
    assert.equal(of('find . -name x -exec rm -rf {} +'), 'deletes every file find matches')
    assert.equal(of('git ls-files -z | xargs -0 rm -rf'), 'deletes a folder only known when the line runs, and everything in it')
    assert.equal(of('shred -u secrets.txt'), 'destroys secrets.txt beyond recovery')
    assert.equal(of('rm -rf build bin'), 'deletes build and everything in it', 'build and bin hold source in some projects')
    for (const line of ['rm -rf node_modules dist', 'rm -rf packages/web/.next', 'rm -rf /tmp/encode-check', 'rm notes.txt', 'rm -f build/*.js', 'ls -la', 'echo rm -rf src']) {
      assert.equal(of(line), null, line)
    }
  })

  it('read PowerShell: Remove-Item -Recurse and its aliases', () => {
    assert.equal(of('Remove-Item -Recurse -Force src', pwsh), 'deletes src and everything in it')
    assert.equal(of('rm -r C:\\Users\\dev\\Documents', pwsh), 'deletes C:\\Users\\dev\\Documents and everything in it')
    assert.equal(of('Remove-Item -Recurse dist', pwsh), null)
    assert.equal(of('Remove-Item notes.txt', pwsh), null)
  })

  it('are git commands that discard work or history, and pushes', () => {
    assert.equal(of('git reset --hard HEAD~1'), 'discards uncommitted changes (git reset --hard)')
    assert.equal(of('git checkout -- src/app.ts'), 'discards uncommitted changes to files')
    assert.equal(of('git checkout .'), 'discards uncommitted changes to files')
    assert.equal(of('git restore src/app.ts'), 'discards uncommitted changes to files')
    assert.equal(of('git clean -fdx'), 'deletes the files git does not track')
    assert.equal(of('git stash drop'), 'throws stashed work away')
    assert.equal(of('git branch -D feature'), 'deletes a branch whose work may not be merged anywhere')
    assert.equal(of('git push --force-with-lease origin main'), 'overwrites history on the remote')
    assert.equal(of('git push origin +main'), 'overwrites history on the remote')
    assert.equal(of('git push origin --delete old'), 'deletes a branch or tag on the remote')
    assert.equal(of('git -C ../other push origin main'), 'sends commits to origin, where others can fetch them')
    assert.equal(of('git filter-repo --path secrets --invert-paths'), 'rewrites the whole history of the repository')
    for (const line of ['git status', 'git checkout -b feature', 'git checkout main', 'git restore --staged src/app.ts', 'git clean -n', 'git branch -d merged', 'git commit -m "x"', 'git reset HEAD file']) {
      assert.equal(of(line), null, line)
    }
  })

  it('publish, act on GitHub, deploy and destroy', () => {
    assert.equal(of('pnpm --filter web publish --access public'), 'publishes a package to the registry')
    assert.equal(of('cargo publish'), 'publishes a crate to crates.io')
    assert.equal(of('docker push ghcr.io/me/app:1'), 'publishes an image')
    assert.equal(of('gh pr merge 12 --squash'), 'changes the repository on GitHub for everyone who uses it (gh pr merge)')
    assert.equal(of('gh api -X DELETE repos/me/app/releases/1'), 'changes the repository on GitHub through its API')
    assert.equal(of('terraform destroy -auto-approve'), 'destroys live infrastructure')
    assert.equal(of('kubectl delete pod web-1'), 'deletes from the cluster')
    assert.equal(of('aws s3 rm s3://bucket --recursive'), 'deletes from the cloud account')
    assert.equal(of('docker system prune -af'), 'deletes containers, images or their data')
    assert.equal(of('vercel --prod'), 'deploys to production')
    for (const line of ['npm run publish-docs', 'npm test', 'terraform plan', 'kubectl get pods', 'docker run --rm node:22 node -v', 'gh pr view 12', 'vercel']) {
      assert.equal(of(line), null, line)
    }
  })

  it('drop or empty databases, erase disks and restart the machine', () => {
    assert.equal(of('psql -c "DROP TABLE users"'), 'drops or empties database data')
    assert.equal(of('sqlite3 app.db "delete from sessions;"'), 'drops or empties database data')
    assert.equal(of('npx prisma migrate reset --force'), 'drops or empties the database')
    assert.equal(of('python manage.py flush --noinput'), 'drops or empties the database')
    assert.equal(of('redis-cli FLUSHALL'), 'drops or empties database data')
    assert.equal(of('sudo mkfs.ext4 /dev/sdb1'), 'erases a disk or partition')
    assert.equal(of('dd if=/dev/zero of=disk.img bs=1M count=1'), 'writes raw data over disk.img')
    assert.equal(of('shutdown -r now'), 'restarts or turns off the machine')
    assert.equal(of('chmod -R 777 /work'), 'changes who may use /work and everything in it')
    for (const line of ['psql -c "select * from users"', 'sqlite3 app.db "delete from sessions where id = 3;"', 'npx prisma migrate dev', 'chmod +x run.sh']) {
      assert.equal(of(line), null, line)
    }
  })

  it('look inside a shell given a program, and match a line it cannot read by its words', () => {
    assert.equal(of('bash -c "rm -rf src"'), 'deletes src and everything in it')
    assert.equal(of('pwsh -Command "Remove-Item -Recurse -Force src"'), 'deletes src and everything in it')
    assert.equal(of('eval "$(cat x)"; rm -rf src'), 'deletes src and everything in it')
    assert.match(of('cmd /c rd /s /q src') ?? '', /cannot be brought back/)
    assert.match(of('for f in $(ls); do rm -rf "$f"; done') ?? '', /deletes|could not read/)
    assert.equal(of(''), null)
  })

  it('reads long, repetitive lines in linear time', () => {
    const started = performance.now()
    for (const shape of ['dd '.repeat(5_000), 'Remove-Item '.repeat(2_000), 'npx prisma db push '.repeat(1_000), 'git push '.repeat(3_000), `rm -rf ${'a/'.repeat(5_000)}`]) {
      hardToUndo(shape, posix)
      hardToUndo(shape, pwsh)
    }
    assert.ok(performance.now() - started < 2_000, `took ${Math.round(performance.now() - started)} ms`)
  })
})
