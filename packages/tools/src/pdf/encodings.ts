/**
 * Character encodings and glyph names (PDF 32000-1:2008, Annex D, and the Adobe Glyph List): what a byte in a
 * simple font's string stands for when the font has no ToUnicode map.
 *
 * Every table is written as code points, never as the characters themselves, so the source stays plain ASCII.
 */

const table = (pairs: readonly number[]): Uint16Array => {
  const codes = new Uint16Array(256)
  for (let i = 0; i + 1 < pairs.length; i += 2) codes[pairs[i]] = pairs[i + 1]
  return codes
}

const ascii = (): number[] => {
  const pairs: number[] = []
  for (let code = 32; code < 127; code++) pairs.push(code, code)
  return pairs
}

/** Latin-1 for 0xA1 to 0xFF. */
const latinHigh = (): number[] => {
  const pairs: number[] = []
  for (let code = 0xa1; code <= 0xff; code++) pairs.push(code, code)
  return pairs
}

export const WIN_ANSI = table([
  ...ascii(),
  ...latinHigh(),
  0x80, 0x20ac, 0x82, 0x201a, 0x83, 0x0192, 0x84, 0x201e, 0x85, 0x2026, 0x86, 0x2020, 0x87, 0x2021, 0x88, 0x02c6, 0x89, 0x2030,
  0x8a, 0x0160, 0x8b, 0x2039, 0x8c, 0x0152, 0x8e, 0x017d, 0x91, 0x2018, 0x92, 0x2019, 0x93, 0x201c, 0x94, 0x201d, 0x95, 0x2022,
  0x96, 0x2013, 0x97, 0x2014, 0x98, 0x02dc, 0x99, 0x2122, 0x9a, 0x0161, 0x9b, 0x203a, 0x9c, 0x0153, 0x9e, 0x017e, 0x9f, 0x0178,
  // WinAnsiEncoding shows 0xA0 as a space and 0xAD as a hyphen.
  0xa0, 0x20, 0xad, 0x2d,
])

export const STANDARD = table([
  ...ascii(),
  0x27, 0x2019, 0x60, 0x2018,
  0xa1, 0x00a1, 0xa2, 0x00a2, 0xa3, 0x00a3, 0xa4, 0x2044, 0xa5, 0x00a5, 0xa6, 0x0192, 0xa7, 0x00a7, 0xa8, 0x00a4, 0xa9, 0x0027,
  0xaa, 0x201c, 0xab, 0x00ab, 0xac, 0x2039, 0xad, 0x203a, 0xae, 0xfb01, 0xaf, 0xfb02, 0xb1, 0x2013, 0xb2, 0x2020, 0xb3, 0x2021,
  0xb4, 0x00b7, 0xb6, 0x00b6, 0xb7, 0x2022, 0xb8, 0x201a, 0xb9, 0x201e, 0xba, 0x201d, 0xbb, 0x00bb, 0xbc, 0x2026, 0xbd, 0x2030,
  0xbf, 0x00bf, 0xc1, 0x0060, 0xc2, 0x00b4, 0xc3, 0x02c6, 0xc4, 0x02dc, 0xc5, 0x00af, 0xc6, 0x02d8, 0xc7, 0x02d9, 0xc8, 0x00a8,
  0xca, 0x02da, 0xcb, 0x00b8, 0xcd, 0x02dd, 0xce, 0x02db, 0xcf, 0x02c7, 0xd0, 0x2014, 0xe1, 0x00c6, 0xe3, 0x00aa, 0xe8, 0x0141,
  0xe9, 0x00d8, 0xea, 0x0152, 0xeb, 0x00ba, 0xf1, 0x00e6, 0xf5, 0x0131, 0xf8, 0x0142, 0xf9, 0x00f8, 0xfa, 0x0153, 0xfb, 0x00df,
])

export const MAC_ROMAN = table([
  ...ascii(),
  0x80, 0xc4, 0x81, 0xc5, 0x82, 0xc7, 0x83, 0xc9, 0x84, 0xd1, 0x85, 0xd6, 0x86, 0xdc, 0x87, 0xe1, 0x88, 0xe0, 0x89, 0xe2, 0x8a, 0xe4,
  0x8b, 0xe3, 0x8c, 0xe5, 0x8d, 0xe7, 0x8e, 0xe9, 0x8f, 0xe8, 0x90, 0xea, 0x91, 0xeb, 0x92, 0xed, 0x93, 0xec, 0x94, 0xee, 0x95, 0xef,
  0x96, 0xf1, 0x97, 0xf3, 0x98, 0xf2, 0x99, 0xf4, 0x9a, 0xf6, 0x9b, 0xf5, 0x9c, 0xfa, 0x9d, 0xf9, 0x9e, 0xfb, 0x9f, 0xfc,
  0xa0, 0x2020, 0xa1, 0xb0, 0xa2, 0xa2, 0xa3, 0xa3, 0xa4, 0xa7, 0xa5, 0x2022, 0xa6, 0xb6, 0xa7, 0xdf, 0xa8, 0xae, 0xa9, 0xa9,
  0xaa, 0x2122, 0xab, 0xb4, 0xac, 0xa8, 0xad, 0x2260, 0xae, 0xc6, 0xaf, 0xd8, 0xb0, 0x221e, 0xb1, 0xb1, 0xb2, 0x2264, 0xb3, 0x2265,
  0xb4, 0xa5, 0xb5, 0xb5, 0xb6, 0x2202, 0xb7, 0x2211, 0xb8, 0x220f, 0xb9, 0x03c0, 0xba, 0x222b, 0xbb, 0xaa, 0xbc, 0xba, 0xbd, 0x03a9,
  0xbe, 0xe6, 0xbf, 0xf8, 0xc0, 0xbf, 0xc1, 0xa1, 0xc2, 0xac, 0xc3, 0x221a, 0xc4, 0x0192, 0xc5, 0x2248, 0xc6, 0x2206, 0xc7, 0xab,
  0xc8, 0xbb, 0xc9, 0x2026, 0xca, 0x20, 0xcb, 0xc0, 0xcc, 0xc3, 0xcd, 0xd5, 0xce, 0x0152, 0xcf, 0x0153, 0xd0, 0x2013, 0xd1, 0x2014,
  0xd2, 0x201c, 0xd3, 0x201d, 0xd4, 0x2018, 0xd5, 0x2019, 0xd6, 0xf7, 0xd7, 0x25ca, 0xd8, 0xff, 0xd9, 0x0178, 0xda, 0x2044, 0xdb, 0xa4,
  0xdc, 0x2039, 0xdd, 0x203a, 0xde, 0xfb01, 0xdf, 0xfb02, 0xe0, 0x2021, 0xe1, 0xb7, 0xe2, 0x201a, 0xe3, 0x201e, 0xe4, 0x2030,
  0xe5, 0xc2, 0xe6, 0xca, 0xe7, 0xc1, 0xe8, 0xcb, 0xe9, 0xc8, 0xea, 0xcd, 0xeb, 0xce, 0xec, 0xcf, 0xed, 0xcc, 0xee, 0xd3, 0xef, 0xd4,
  0xf1, 0xd2, 0xf2, 0xda, 0xf3, 0xdb, 0xf4, 0xd9, 0xf5, 0x0131, 0xf6, 0x02c6, 0xf7, 0x02dc, 0xf8, 0xaf, 0xf9, 0x02d8, 0xfa, 0x02d9,
  0xfb, 0x02da, 0xfc, 0xb8, 0xfd, 0x02dd, 0xfe, 0x02db, 0xff, 0x02c7,
])

/** The Symbol font's own encoding: Greek letters and mathematics. */
export const SYMBOL = table([
  ...ascii(),
  0x22, 0x2200, 0x24, 0x2203, 0x27, 0x220b, 0x2a, 0x2217, 0x2d, 0x2212, 0x40, 0x2245, 0x5c, 0x2234, 0x5e, 0x22a5, 0x60, 0x0020, 0x7e, 0x223c,
  0x41, 0x0391, 0x42, 0x0392, 0x43, 0x03a7, 0x44, 0x0394, 0x45, 0x0395, 0x46, 0x03a6, 0x47, 0x0393, 0x48, 0x0397, 0x49, 0x0399,
  0x4a, 0x03d1, 0x4b, 0x039a, 0x4c, 0x039b, 0x4d, 0x039c, 0x4e, 0x039d, 0x4f, 0x039f, 0x50, 0x03a0, 0x51, 0x0398, 0x52, 0x03a1,
  0x53, 0x03a3, 0x54, 0x03a4, 0x55, 0x03a5, 0x56, 0x03c2, 0x57, 0x03a9, 0x58, 0x039e, 0x59, 0x03a8, 0x5a, 0x0396,
  0x61, 0x03b1, 0x62, 0x03b2, 0x63, 0x03c7, 0x64, 0x03b4, 0x65, 0x03b5, 0x66, 0x03c6, 0x67, 0x03b3, 0x68, 0x03b7, 0x69, 0x03b9,
  0x6a, 0x03d5, 0x6b, 0x03ba, 0x6c, 0x03bb, 0x6d, 0x03bc, 0x6e, 0x03bd, 0x6f, 0x03bf, 0x70, 0x03c0, 0x71, 0x03b8, 0x72, 0x03c1,
  0x73, 0x03c3, 0x74, 0x03c4, 0x75, 0x03c5, 0x76, 0x03d6, 0x77, 0x03c9, 0x78, 0x03be, 0x79, 0x03c8, 0x7a, 0x03b6,
  0xa1, 0x03d2, 0xa2, 0x2032, 0xa3, 0x2264, 0xa4, 0x2044, 0xa5, 0x221e, 0xa6, 0x0192, 0xa7, 0x2663, 0xa8, 0x2666, 0xa9, 0x2665,
  0xaa, 0x2660, 0xab, 0x2194, 0xac, 0x2190, 0xad, 0x2191, 0xae, 0x2192, 0xaf, 0x2193, 0xb0, 0x00b0, 0xb1, 0x00b1, 0xb2, 0x2033,
  0xb3, 0x2265, 0xb4, 0x00d7, 0xb5, 0x221d, 0xb6, 0x2202, 0xb7, 0x2022, 0xb8, 0x00f7, 0xb9, 0x2260, 0xba, 0x2261, 0xbb, 0x2248,
  0xbc, 0x2026, 0xbf, 0x21b5, 0xc0, 0x2135, 0xc1, 0x2111, 0xc2, 0x211c, 0xc3, 0x2118, 0xc4, 0x2297, 0xc5, 0x2295, 0xc6, 0x2205,
  0xc7, 0x2229, 0xc8, 0x222a, 0xc9, 0x2283, 0xca, 0x2287, 0xcb, 0x2284, 0xcc, 0x2282, 0xcd, 0x2286, 0xce, 0x2208, 0xcf, 0x2209,
  0xd0, 0x2220, 0xd1, 0x2207, 0xd2, 0x00ae, 0xd3, 0x00a9, 0xd4, 0x2122, 0xd5, 0x220f, 0xd6, 0x221a, 0xd7, 0x22c5, 0xd8, 0x00ac,
  0xd9, 0x2227, 0xda, 0x2228, 0xdb, 0x21d4, 0xdc, 0x21d0, 0xdd, 0x21d1, 0xde, 0x21d2, 0xdf, 0x21d3, 0xe0, 0x25ca, 0xe1, 0x2329,
  0xe5, 0x2211, 0xf1, 0x232a, 0xf2, 0x222b,
])

export const BASE_ENCODINGS: Record<string, Uint16Array> = {
  WinAnsiEncoding: WIN_ANSI,
  StandardEncoding: STANDARD,
  MacRomanEncoding: MAC_ROMAN,
  // MacExpertEncoding holds small capitals and old-style figures; Latin-1 order is the closest plain reading.
  MacExpertEncoding: WIN_ANSI,
  PDFDocEncoding: WIN_ANSI,
}

// ---------------------------------------------------------------------------
// Glyph names

const NAMES = new Map<string, number>()
const name = (pairs: string): void => {
  for (const pair of pairs.trim().split(/\s+/)) {
    const [glyph, hex] = pair.split('=')
    NAMES.set(glyph, parseInt(hex, 16))
  }
}

// ASCII.
name(`space=20 exclam=21 quotedbl=22 numbersign=23 dollar=24 percent=25 ampersand=26 quotesingle=27 parenleft=28 parenright=29
asterisk=2a plus=2b comma=2c hyphen=2d period=2e slash=2f zero=30 one=31 two=32 three=33 four=34 five=35 six=36 seven=37 eight=38
nine=39 colon=3a semicolon=3b less=3c equal=3d greater=3e question=3f at=40 bracketleft=5b backslash=5c bracketright=5d
asciicircum=5e underscore=5f grave=60 braceleft=7b bar=7c braceright=7d asciitilde=7e`)
for (let code = 0x41; code <= 0x5a; code++) NAMES.set(String.fromCharCode(code), code)
for (let code = 0x61; code <= 0x7a; code++) NAMES.set(String.fromCharCode(code), code)

// Latin-1.
name(`nbspace=a0 exclamdown=a1 cent=a2 sterling=a3 currency=a4 yen=a5 brokenbar=a6 section=a7 dieresis=a8 copyright=a9
ordfeminine=aa guillemotleft=ab logicalnot=ac sfthyphen=ad registered=ae macron=af degree=b0 plusminus=b1 twosuperior=b2
threesuperior=b3 acute=b4 mu=b5 paragraph=b6 periodcentered=b7 cedilla=b8 onesuperior=b9 ordmasculine=ba guillemotright=bb
onequarter=bc onehalf=bd threequarters=be questiondown=bf Agrave=c0 Aacute=c1 Acircumflex=c2 Atilde=c3 Adieresis=c4 Aring=c5
AE=c6 Ccedilla=c7 Egrave=c8 Eacute=c9 Ecircumflex=ca Edieresis=cb Igrave=cc Iacute=cd Icircumflex=ce Idieresis=cf Eth=d0
Ntilde=d1 Ograve=d2 Oacute=d3 Ocircumflex=d4 Otilde=d5 Odieresis=d6 multiply=d7 Oslash=d8 Ugrave=d9 Uacute=da Ucircumflex=db
Udieresis=dc Yacute=dd Thorn=de germandbls=df agrave=e0 aacute=e1 acircumflex=e2 atilde=e3 adieresis=e4 aring=e5 ae=e6
ccedilla=e7 egrave=e8 eacute=e9 ecircumflex=ea edieresis=eb igrave=ec iacute=ed icircumflex=ee idieresis=ef eth=f0 ntilde=f1
ograve=f2 oacute=f3 ocircumflex=f4 otilde=f5 odieresis=f6 divide=f7 oslash=f8 ugrave=f9 uacute=fa ucircumflex=fb udieresis=fc
yacute=fd thorn=fe ydieresis=ff`)

// Punctuation, symbols and ligatures from the standard encodings.
name(`Euro=20ac quotesinglbase=201a florin=192 quotedblbase=201e ellipsis=2026 dagger=2020 daggerdbl=2021 circumflex=2c6
perthousand=2030 Scaron=160 guilsinglleft=2039 OE=152 Zcaron=17d quoteleft=2018 quoteright=2019 quotedblleft=201c
quotedblright=201d bullet=2022 endash=2013 emdash=2014 tilde=2dc trademark=2122 scaron=161 guilsinglright=203a oe=153
zcaron=17e Ydieresis=178 fraction=2044 fi=fb01 fl=fb02 ff=fb00 ffi=fb03 ffl=fb04 dotlessi=131 dotlessj=237 lslash=142
Lslash=141 ring=2da breve=2d8 dotaccent=2d9 hungarumlaut=2dd ogonek=2db caron=2c7 minus=2212 notequal=2260 lessequal=2264
greaterequal=2265 infinity=221e approxequal=2248 summation=2211 product=220f integral=222b radical=221a partialdiff=2202
Delta=2206 Omega=3a9 pi=3c0 lozenge=25ca minute=2032 second=2033 periodcentered=b7 middot=b7 arrowright=2192 arrowleft=2190
arrowup=2191 arrowdown=2193 arrowboth=2194 arrowdblright=21d2 arrowdblleft=21d0 arrowdblboth=21d4 element=2208
notelement=2209 universal=2200 existential=2203 emptyset=2205 intersection=2229 union=222a logicaland=2227 logicalor=2228
proportional=221d equivalence=2261 similar=223c congruent=2245 propersubset=2282 propersuperset=2283 reflexsubset=2286
reflexsuperset=2287 circleplus=2295 circlemultiply=2297 gradient=2207 angle=2220 perpendicular=22a5 therefore=2234
dotmath=22c5 aleph=2135 weierstrass=2118 Ifraktur=2111 Rfraktur=211c checkmark=2713 degree=b0 asteriskmath=2217
openbullet=25e6 filledbox=25a0 filledrect=25ac triagup=25b2 triagdn=25bc club=2663 diamond=2666 heart=2665 spade=2660
quotedblprime=2033 primerev=2035 exclamdbl=203c estimated=212e numero=2116 afii61352=2116 commaaccent=326 nbhyphen=2011
hyphentwo=2010 figuredash=2012 horizontalbar=2015 underscoredbl=2017 quotereversed=201b onedotenleader=2024 twodotenleader=2025
colonmonetary=20a1 franc=20a3 lira=20a4 peseta=20a7 dong=20ab rupee=20a8 won=20a9 sheqel=20aa`)

// Latin Extended-A, the accented letters of Central European languages.
name(`Amacron=100 amacron=101 Abreve=102 abreve=103 Aogonek=104 aogonek=105 Cacute=106 cacute=107 Ccircumflex=108
ccircumflex=109 Cdotaccent=10a cdotaccent=10b Ccaron=10c ccaron=10d Dcaron=10e dcaron=10f Dcroat=110 dcroat=111 Emacron=112
emacron=113 Ebreve=114 ebreve=115 Edotaccent=116 edotaccent=117 Eogonek=118 eogonek=119 Ecaron=11a ecaron=11b Gcircumflex=11c
gcircumflex=11d Gbreve=11e gbreve=11f Gdotaccent=120 gdotaccent=121 Gcommaaccent=122 gcommaaccent=123 Hcircumflex=124
hcircumflex=125 Hbar=126 hbar=127 Itilde=128 itilde=129 Imacron=12a imacron=12b Ibreve=12c ibreve=12d Iogonek=12e iogonek=12f
Idotaccent=130 IJ=132 ij=133 Jcircumflex=134 jcircumflex=135 Kcommaaccent=136 kcommaaccent=137 kgreenlandic=138 Lacute=139
lacute=13a Lcommaaccent=13b lcommaaccent=13c Lcaron=13d lcaron=13e Ldot=13f ldot=140 Nacute=143 nacute=144 Ncommaaccent=145
ncommaaccent=146 Ncaron=147 ncaron=148 napostrophe=149 Eng=14a eng=14b Omacron=14c omacron=14d Obreve=14e obreve=14f
Ohungarumlaut=150 ohungarumlaut=151 Racute=154 racute=155 Rcommaaccent=156 rcommaaccent=157 Rcaron=158 rcaron=159 Sacute=15a
sacute=15b Scircumflex=15c scircumflex=15d Scedilla=15e scedilla=15f Tcommaaccent=162 tcommaaccent=163 Tcaron=164 tcaron=165
Tbar=166 tbar=167 Utilde=168 utilde=169 Umacron=16a umacron=16b Ubreve=16c ubreve=16d Uring=16e uring=16f Uhungarumlaut=170
uhungarumlaut=171 Uogonek=172 uogonek=173 Wcircumflex=174 wcircumflex=175 Ycircumflex=176 ycircumflex=177 Zacute=179 zacute=17a
Zdotaccent=17b zdotaccent=17c longs=17f Scommaaccent=218 scommaaccent=219 Tcommaaccent=21a tcommaaccent=21b`)

// Greek.
name(`Alpha=391 Beta=392 Gamma=393 Epsilon=395 Zeta=396 Eta=397 Theta=398 Iota=399 Kappa=39a Lambda=39b Mu=39c Nu=39d Xi=39e
Omicron=39f Pi=3a0 Rho=3a1 Sigma=3a3 Tau=3a4 Upsilon=3a5 Phi=3a6 Chi=3a7 Psi=3a8 alpha=3b1 beta=3b2 gamma=3b3 delta=3b4
epsilon=3b5 zeta=3b6 eta=3b7 theta=3b8 iota=3b9 kappa=3ba lambda=3bb nu=3bd xi=3be omicron=3bf rho=3c1 sigma1=3c2 sigma=3c3
tau=3c4 upsilon=3c5 phi=3c6 chi=3c7 psi=3c8 omega=3c9 theta1=3d1 Upsilon1=3d2 phi1=3d5 omega1=3d6`)

// TeX fonts' own names for what the standard encodings call otherwise.
name(`visiblespace=2423 suppress=0 dieresisacute=385 Gammaslanted=393 Deltaslanted=394 ff=fb00 ffi=fb03 ffl=fb04
quotedblright=201d exclamdown=a1 questiondown=bf`)

// AFII names for Cyrillic: А to Я and а to я run in order, with Ё and ё where the AFII numbering puts them.
for (let i = 0; i < 33; i++) {
  const upper = 10017 + i
  const lower = 10065 + i
  NAMES.set(`afii${upper}`, i === 6 ? 0x0401 : 0x0410 + i - (i > 6 ? 1 : 0))
  NAMES.set(`afii${lower}`, i === 6 ? 0x0451 : 0x0430 + i - (i > 6 ? 1 : 0))
}

/** The text a glyph name stands for (Adobe Glyph List rules), or undefined. "f_i" and "uni00660069" give two letters. */
export function glyphText(glyph: string): string | undefined {
  const base = glyph.split('.', 1)[0]
  if (!base) return undefined
  const parts = base.split('_')
  let out = ''
  for (const part of parts) {
    const known = NAMES.get(part)
    if (known !== undefined) {
      if (known) out += String.fromCodePoint(known)
      continue
    }
    const uni = /^uni((?:[0-9A-F]{4})+)$/.exec(part)
    if (uni) {
      for (let i = 0; i < uni[1].length; i += 4) {
        const code = parseInt(uni[1].slice(i, i + 4), 16)
        if (code < 0xd800 || code > 0xdfff) out += String.fromCharCode(code)
      }
      continue
    }
    const u = /^u([0-9A-F]{4,6})$/.exec(part)
    if (u) {
      const code = parseInt(u[1], 16)
      if (code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) out += String.fromCodePoint(code)
      continue
    }
    return undefined
  }
  return out || undefined
}

// ---------------------------------------------------------------------------
// Widths of the standard fonts, for files that name one without giving widths

/** Widths of codes 32 to 126 in thousandths of the font size, in ASCII order (39 and 96 are the quotes). */
const widths = (list: string): Uint16Array => Uint16Array.from(list.trim().split(/\s+/).map(Number))

const HELVETICA = widths(`278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556
278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667
611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500
500 334 260 334 584`)
const HELVETICA_BOLD = widths(`278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556
556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667
667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556
556 500 389 280 389 584`)
const TIMES = widths(`250 333 408 500 500 833 778 180 333 333 500 564 250 333 250 278 500 500 500 500 500 500 500 500 500 500 278
278 564 564 564 444 921 722 667 667 722 611 556 722 722 333 389 722 611 889 722 722 556 722 667 556 611 722 722 944 722 722 611
333 278 333 469 500 333 444 500 444 500 444 333 500 500 278 278 500 278 778 500 500 500 500 333 389 278 500 500 722 500 500 444
480 200 480 541`)
const TIMES_BOLD = widths(`250 333 555 500 500 1000 833 278 333 333 500 570 250 333 250 278 500 500 500 500 500 500 500 500 500
500 333 333 570 570 570 500 930 722 667 722 722 667 611 778 778 389 500 778 667 944 722 778 611 778 722 556 667 722 722 1000 722
722 667 333 278 333 581 500 333 500 556 444 556 444 333 500 556 278 333 556 278 833 556 500 556 556 444 389 333 556 500 722 500
500 444 394 220 394 520`)

/** The width of a code in one of the 14 standard fonts, when the file gives none; undefined for other fonts. */
export function standardWidth(baseFont: string, code: number): number | undefined {
  const font = baseFont.replace(/^[A-Z]{6}\+/, '')
  if (/Courier/i.test(font)) return 600
  const bold = /Bold|Black|Heavy/i.test(font)
  const metrics = /Times|Roman|Serif|Georgia/i.test(font) ? (bold ? TIMES_BOLD : TIMES) : /Helvetica|Arial|Sans/i.test(font) ? (bold ? HELVETICA_BOLD : HELVETICA) : undefined
  if (!metrics) return undefined
  return code >= 32 && code <= 126 ? metrics[code - 32] : bold ? 556 : 500
}
