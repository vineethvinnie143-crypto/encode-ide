import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { check, gen } from '@encode/testkit'
import { checkFetchUrl, isPublicAddress, parseIPv4, parseIPv6 } from './egress'

const PUBLIC = [
  '8.8.8.8',
  '1.1.1.1',
  '93.184.215.14',
  '9.255.255.255',
  '11.0.0.0',
  '100.63.255.255',
  '100.128.0.0',
  '126.255.255.255',
  '128.0.0.0',
  '169.253.255.255',
  '172.15.255.255',
  '172.32.0.0',
  '198.17.255.255',
  '198.20.0.0',
  '223.255.255.255',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '2a00:1450:4001:82a::200e',
  '::ffff:8.8.8.8',
  '::ffff:808:808',
  '64:ff9b::808:808',
  '2002:808:808::1',
]

const NOT_PUBLIC = [
  '0.0.0.0',
  '0.1.2.3',
  '127.0.0.1',
  '127.255.255.254',
  '10.1.2.3',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '100.127.255.255',
  '192.0.0.170',
  '192.0.2.1',
  '192.88.99.1',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '239.255.255.250',
  '240.0.0.1',
  '255.255.255.255',
  '::',
  '::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:10.0.0.1',
  '::ffff:169.254.169.254',
  '::127.0.0.1',
  '64:ff9b::7f00:1',
  '64:ff9b::a9fe:a9fe',
  '64:ff9b:1::1',
  '2002:7f00:1::',
  '2002:a9fe:a9fe::1',
  'fe80::1',
  'fe80::1%eth0',
  'fc00::1',
  'fd12:3456::1',
  'ff02::1',
  '100::1',
  '2001:db8::1',
  '2001::1',
  '2001:2::1',
  '2001:10::1',
  '2001:20::1',
  '3fff::1',
  // Not canonical addresses at all.
  '',
  'localhost',
  '127.1',
  '0x7f.0.0.1',
  '010.0.0.1',
  '1.2.3.256',
  '1::2::3',
  '1:2:3:4:5:6:7:8:9',
  'gggg::1',
]

describe('isPublicAddress', () => {
  it('accepts public unicast addresses', () => {
    for (const address of PUBLIC) assert.equal(isPublicAddress(address), true, address)
  })

  it('refuses private, loopback, link-local and other special-purpose addresses', () => {
    for (const address of NOT_PUBLIC) assert.equal(isPublicAddress(address), false, address)
  })

  it('judges an IPv4 address the same in every IPv6 wrapping', async () => {
    const hex = (n: number) => n.toString(16)
    await check(gen.tuple(gen.int(0, 255), gen.int(0, 255), gen.int(0, 255), gen.int(0, 255)), ([a, b, c, d]) => {
      const dotted = `${a}.${b}.${c}.${d}`
      const high = hex((a << 8) | b)
      const low = hex((c << 8) | d)
      const expected = isPublicAddress(dotted)
      assert.equal(isPublicAddress(`::ffff:${dotted}`), expected, `mapped ${dotted}`)
      assert.equal(isPublicAddress(`::ffff:${high}:${low}`), expected, `mapped hex ${dotted}`)
      assert.equal(isPublicAddress(`64:ff9b::${high}:${low}`), expected, `NAT64 ${dotted}`)
      assert.equal(isPublicAddress(`2002:${high}:${low}::1`), expected, `6to4 ${dotted}`)
    }, { runs: 3000 })
  })
})

describe('address parsing', () => {
  it('reads dotted quads and IPv6 forms', () => {
    assert.equal(parseIPv4('192.168.0.1'), 0xc0a80001)
    assert.deepEqual(parseIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1])
    assert.deepEqual(parseIPv6('2001:db8::8:800:200c:417a'), [0x2001, 0xdb8, 0, 0, 0x8, 0x800, 0x200c, 0x417a])
    assert.deepEqual(parseIPv6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304])
    assert.deepEqual(parseIPv6('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8])
    assert.equal(parseIPv6('1:2:3:4:5:6:7'), null)
    assert.equal(parseIPv6('1:2:3:4::5:6:7:8'), null)
  })
})

describe('checkFetchUrl', () => {
  it('accepts http and https URLs and reports the host', () => {
    const result = checkFetchUrl('HTTPS://Docs.Example.COM/a?b=1')
    assert.ok(result.ok)
    assert.equal(result.host, 'docs.example.com')
    assert.ok(checkFetchUrl('http://localhost:3000/').ok, 'host names are checked after DNS, not here')
  })

  it('refuses other schemes, credentials and literal private addresses in any spelling', () => {
    const refused = [
      'ftp://example.com/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'http://user:secret@example.com/',
      'http://127.0.0.1/',
      'http://[::1]:8080/',
      'http://[::ffff:127.0.0.1]/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://127.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0:3000/',
      'not a url',
    ]
    for (const url of refused) assert.equal(checkFetchUrl(url).ok, false, url)
  })
})
