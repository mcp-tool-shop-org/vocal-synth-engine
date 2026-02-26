<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.zh.md">中文</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.hi.md">हिन्दी</a> ·
  <a href="README.it.md">Italiano</a> ·
  <a href="README.pt-BR.md">Português</a>
</p>

<p align="center">
  
            <img src="https://raw.githubusercontent.com/mcp-tool-shop-org/brand/main/logos/vocal-synth-engine/readme.png"
           alt="Vocal Synth Engine" width="400" />
</p>

<p align="center">
  <a href="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml"><img src="https://github.com/mcp-tool-shop-org/vocal-synth-engine/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT">
  <a href="https://mcp-tool-shop-org.github.io/vocal-synth-engine/"><img src="https://img.shields.io/badge/Landing_Page-live-blue" alt="Landing Page"></a>
</p>

<p align="center"><strong>Deterministic vocal instrument engine — additive synthesis, voice presets, real-time WebSocket streaming, multi-user jam sessions, cockpit UI</strong></p>

टाइपस्क्रिप्ट में निर्मित एक नियतात्मक वोकल इंस्ट्रूमेंट इंजन। यह योज्य संश्लेषण, वोकल प्रीसेट और रीयल-टाइम वेबसॉकेट स्ट्रीमिंग का उपयोग करके स्कोर डेटा से गायन की आवाज़ उत्पन्न करता है। आप इसे कीबोर्ड/MIDI के माध्यम से लाइव बजा सकते हैं, मल्टी-यूजर जैम सत्रों में सहयोग कर सकते हैं, या स्कोर को WAV फ़ाइल में बदल सकते हैं।

## यह क्या करता है

- **योज्य वोकल संश्लेषण:** हार्मोनिक आंशिक + स्पेक्ट्रल एनवेलप + शोर अवशिष्ट
- **15 वोकल प्रीसेट:** कोकोरो टीटीएस आवाज़ों से प्राप्त विश्लेषण डेटा + लैब प्रीसेट, प्रत्येक में कई टिम्बर (ध्वनि गुण)
- **पॉलिफोनिक रेंडरिंग:** कॉन्फ़िगर करने योग्य अधिकतम पॉलीफोनी, प्रत्येक आवाज के लिए स्टेट मैनेजमेंट और वॉइस स्टीलिंग
- **लाइव मोड:** कीबोर्ड या MIDI के माध्यम से नोट्स बजाएं, रीयल-टाइम वेबसॉकेट ऑडियो स्ट्रीमिंग के साथ
- **जैम सत्र:** होस्ट प्राधिकरण, प्रतिभागी पहचान और रिकॉर्डिंग के साथ मल्टी-यूजर सहयोगी सत्र
- **स्कोर इनपुट:** स्वचालित प्लेबैक के लिए एक `VocalScore` को ट्रैक में लोड करें, जो ट्रांसपोर्ट के साथ सिंक्रोनाइज़ होगा
- **रिकॉर्डिंग और निर्यात:** लाइव प्रदर्शन को एक इवेंटटेप में कैप्चर करें, पूर्ण जानकारी के साथ WAV में निर्यात करें
- **गीत और ध्वन्यात्मकता:** ग्राफीम-टू-फोनिम पाइपलाइन, ध्वन्यात्मकता लेन विज़ुअलाइज़ेशन
- **कॉकपिट यूआई:** पियानो रोल एडिटर, लाइव कीबोर्ड, XY पैड, रेंडर बैंक और टेलीमेट्री के साथ ब्राउज़र-आधारित SPA
- **नियतात्मक:** सीडेड RNG, समान इनपुट से पुनरुत्पादित आउटपुट

## आर्किटेक्चर

```
                          ┌─── Cockpit UI (browser SPA) ───┐
                          │  Piano Roll  │  Live  │ Renders │
                          └──────────────┴────────┴─────────┘
                                     │        │
                              REST API    WebSocket
                                     │    /ws  /ws/jam
                          ┌──────────┴────────┴─────────────┐
                          │        Express Server            │
                          │  Render API │ Jam Sessions       │
                          └──────┬──────┴───────┬────────────┘
                                 │              │
                      StreamingVocalSynthEngine  │
                        LiveSynthEngine ─────────┘
                                 │
                    ┌────────────┼─────────────┐
              VoicePreset    DSP (FFT)    Curves (ADSR,
              (.f32 blobs)   Pitch Det.   vibrato, automation)
```

**मुख्य निर्देशिकाएँ:**

| निर्देशिका | उद्देश्य |
| ----------- | --------- |
| `src/engine/` | कोर सिंथ — ब्लॉक रेंडरर, स्ट्रीमिंग इंजन, ADSR/विब्रेटो कर्व |
| `src/dsp/` | सिग्नल प्रोसेसिंग — FFT, पिच डिटेक्शन |
| `src/preset/` | वॉइस प्रीसेट स्कीमा, लोडर और रिज़ॉल्वर |
| `src/server/` | एक्सप्रेस + वेबसॉकेट एपीआई सर्वर, जैम सेशन मैनेजर |
| `src/types/` | साझा प्रकार — स्कोर, जैम प्रोटोकॉल, प्रीसेट |
| `src/cli/` | CLI उपकरण + एकीकरण परीक्षण सूट |
| `apps/cockpit/` | ब्राउज़र कॉकपिट यूआई (विटे + वैनिला TS) |
| `presets/` | 15 बंडल वोकल प्रीसेट, जिनमें बाइनरी टिम्बर डेटा शामिल है |

## शुरुआत कैसे करें

```bash
npm ci
npm run dev
```

डेवलपमेंट सर्वर `http://localhost:4321` पर शुरू होता है। कॉकपिट यूआई भी उसी पोर्ट से परोसा जाता है।

## कॉकपिट यूआई

कॉकपिट एक ब्राउज़र-आधारित SPA है जिसमें तीन टैब हैं:

### स्कोर एडिटर
- ड्रैग-टू-क्रिएट, मूव और रीसाइज़ नोट्स के साथ पियानो रोल (C2-C6 रेंज)
- प्रति-नोट नियंत्रण: वेलोसिटी, टिम्बर, सांस, विब्रेटो, पोर्टामेंटो
- स्वचालित ध्वन्यात्मकता पीढ़ी के साथ गीत इनपुट
- पियानो रोल के साथ सिंक्रोनाइज़ ध्वन्यात्मकता लेन ओवरले
- कॉन्फ़िगर करने योग्य प्रीसेट, पॉलीफोनी, सीड और बीपीएम के साथ WAV में रेंडर करें

### लाइव मोड
- 24-कुंजी क्रोमैटिक कीबोर्ड (माउस + की बाइंडिंग)
- चैनल फ़िल्टरिंग के साथ MIDI डिवाइस इनपुट
- रीयल-टाइम टिम्बर मॉर्फिंग (X) और सांस (Y) के लिए XY पैड
- होल्ड पैडल, वेलोसिटी/सांस स्लाइडर, विब्रेटो नियंत्रण
- क्वांटाइज ग्रिड (1/4, 1/8, 1/16) के साथ मेट्रोनोम
- विलंबता अंशांकन (कम/संतुलित/सुरक्षित प्रीसेट)
- प्रदर्शन रिकॉर्ड करें और रेंडर बैंक में सहेजें
- लाइव टेलीमेट्री: आवाजें, पीक dBFS, RTF, क्लिक जोखिम, WS जिटर

### रेंडर बैंक
- सहेजे गए रेंडर को ब्राउज़ करें, चलाएं, पिन करें, नाम बदलें और हटाएं
- रेंडर का स्कोर वापस एडिटर में लोड करें
- रेंडर के बीच साइड-बाय-साइड टेलीमेट्री तुलना
- उत्पत्ति ट्रैकिंग: कमिट SHA, स्कोर हैश, WAV हैश

## जैम सत्र

वेबसॉकेट (`/ws/jam`) पर मल्टी-यूजर सहयोगी सत्र:

- **होस्ट अधिकार** — सत्र बनाने वाला व्यक्ति परिवहन, ट्रैक, रिकॉर्डिंग और क्वांटाइजेशन को नियंत्रित करता है।
- **अतिथि भागीदारी** — अतिथि उपयोगकर्ता किसी भी ट्रैक पर नोट्स बजा सकते हैं, लेकिन वे सत्र की स्थिति को नहीं बदल सकते।
- **ट्रैक स्वामित्व** — ट्रैक उनके निर्माता के होते हैं; केवल मालिक या होस्ट ही उन्हें बदल या हटा सकता है।
- **भागीदार का विवरण** — इवेंटटेप में प्रत्येक नोट इवेंट में यह दर्ज होता है कि किसने उसे बजाया।
- **स्कोर इनपुट मोड** — स्वचालित प्लेबैक के लिए एक `वॉयस स्कोर` को ट्रैक में लोड करें, जो परिवहन के साथ सिंक्रनाइज़ होगा।
- **रिकॉर्डिंग** — सभी प्रतिभागियों के नोट्स को इवेंटटेप में कैप्चर करें, और इसे WAV फॉर्मेट में एक्सपोर्ट करें।
- **मेट्रोनोम** — कॉन्फ़िगर करने योग्य बीपीएम और टाइम सिग्नेचर वाला एक साझा मेट्रोनोम।

### जाम प्रोटोकॉल

क्लाइंट `/ws/jam` से कनेक्ट होते हैं और JSON संदेशों का आदान-प्रदान करते हैं:

```
Client: jam_hello → Server: jam_hello_ack (participantId)
Client: session_create → Server: session_created (snapshot)
Client: session_join → Server: session_joined (snapshot)
Client: track_note_on/off → Server: track_note_ack
Client: record_start/stop → Server: record_status
Client: record_export → Server: record_exported (renderId)
Client: track_set_score → Server: score_status
```

## एपीआई

| एंडपॉइंट | विधि | Auth | विवरण |
| ---------- | -------- | ------ | ------------- |
| `/api/health` | GET | No | सर्वर की स्थिति, संस्करण, अपटाइम |
| `/api/presets` | GET | No | टिमब्र और मेटाडेटा के साथ वॉयस प्रीसेट की सूची |
| `/api/phonemize` | POST | Yes | गीत के पाठ को फोनिम इवेंट में बदलें |
| `/api/render` | POST | Yes | एक स्कोर को WAV में बदलें |
| `/api/renders` | GET | Yes | सभी सहेजे गए रूपांतरणों की सूची |
| `/api/renders/:id/audio.wav` | GET | Yes | रूपांतरण WAV फ़ाइल डाउनलोड करें |
| `/api/renders/:id/score` | GET | Yes | मूल स्कोर JSON |
| `/api/renders/:id/meta` | GET | Yes | रूपांतरण मेटाडेटा |
| `/api/renders/:id/telemetry` | GET | Yes | रूपांतरण टेलीमेट्री (पीक, आरटीएफ, क्लिक) |
| `/api/renders/:id/provenance` | GET | Yes | उत्पत्ति (कमिट, हैश, कॉन्फ़िगरेशन) |

प्रमाणीकरण वैकल्पिक है — यह तभी सक्षम होता है जब `AUTH_TOKEN` को पर्यावरण में सेट किया गया हो।

### वेबसॉकेट

| Path | उद्देश्य |
| ------ | --------- |
| `/ws` | लाइव मोड — ऑडियो स्ट्रीमिंग के साथ सिंगल-यूजर नोट प्लेबैक |
| `/ws/jam` | जाम सत्र — रिकॉर्डिंग के साथ मल्टी-यूजर सहयोग |

## वॉयस प्रीसेट

मल्टी-टिमब्र सपोर्ट के साथ 15 प्रीसेट:

| प्रीसेट | Voice | टिमब्र |
| -------- | ------- | --------- |
| `default-voice` | बेसिक फीमेल | डिफ़ॉल्ट टिमब्र |
| `bright-lab` | लैब/प्रायोगिक | ब्राइट फॉर्मेंट |
| `kokoro-af-*` | एओडे, हार्ट, जेसिका, स्काई | प्रत्येक वॉयस के लिए कई |
| `kokoro-am-*` | एरिक, फेनफ़िर, लियाम, ओनिक्स | प्रत्येक वॉयस के लिए कई |
| `kokoro-bf-*` | ऐलिस, एम्मा, इसाबेला | प्रत्येक वॉयस के लिए कई |
| `kokoro-bm-*` | जॉर्ज, लुईस | प्रत्येक वॉयस के लिए कई |

प्रत्येक प्रीसेट में बाइनरी `.f32` एसेट (हार्मोनिक मैग्नीट्यूड, स्पेक्ट्रल एनवेलप, नॉइज़ फ्लोर) और एक JSON मैनिफेस्ट शामिल है जो पिच रेंज, रेजोनेंस और वाइब्रेटो डिफ़ॉल्ट का वर्णन करता है।

## स्क्रिप्ट

```bash
npm run dev          # Dev server with hot reload
npm run build        # Build cockpit + server
npm start            # Production server
npm run inspect      # CLI preset inspector
```

## टेस्ट

एकीकरण परीक्षण एक लाइव डेवलपमेंट सर्वर के खिलाफ चलाए जाते हैं:

```bash
# Start the server first
npm run dev

# Then in another terminal:
npx tsx src/cli/test-jam-session.ts        # Jam session lifecycle (12 tests)
npx tsx src/cli/test-jam-recording.ts      # Recording & export (10 tests)
npx tsx src/cli/test-jam-collaboration.ts  # Collaboration & score input (12 tests)
npx tsx src/cli/test-score-render.ts       # Score rendering pipeline
npx tsx src/cli/test-consonants.ts         # Consonant phonemes
npx tsx src/cli/test-g2p.ts               # Grapheme-to-phoneme
npx tsx src/cli/test-lyrics-golden.ts      # Lyrics golden tests
npx tsx src/cli/test-multi-timbre.ts       # Multi-timbre rendering
npx tsx src/cli/test-noise-tail.ts         # Tail silence/noise
```

## लाइसेंस

एमआईटी। [लाइसेंस](LICENSE) देखें।
