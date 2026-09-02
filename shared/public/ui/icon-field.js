/**
 * The curated emoji dataset and the pure rules behind the icon field: what
 * the picker offers, what typing/pasting anything else still does, and what
 * gets shown for either — plus the DOM half that wires `#icon-*` (the
 * `<input>`, the preview, the picker panel and its keyboard grid) inside
 * `#habit-dialog`.
 *
 * The dataset and `previewIcon`/`searchEmoji` above stay DOM-free for the same
 * reason `ui/toggle.js` and `ui/amount.js` are: `test/icon-field.test.js` runs
 * them under plain Node with no browser and no `/shared/...` module
 * resolution, which is also why nothing here imports `shared/src` — the
 * browser is never handed that directory. The DOM half below keeps that test
 * running by construction rather than by care: every element lookup happens
 * INSIDE `initIconField()`, never at module scope, so importing this file
 * under Node touches no `document` until something calls it — which the Node
 * test never does.
 */

/**
 * @typedef {{glyph: string, name: string, keywords: string[], group: string}} EmojiEntry
 */

/**
 * A curated slice of the habit vocabulary, not the full Unicode emoji set —
 * that would need a search index and a build step this project does not have
 * (see the issue and `shared/public/CLAUDE.md`). Groups are declaration
 * order, not alphabetical, because the panel renders them in that order and a
 * later tier (#66 tier 2) should be able to append a group without reordering
 * this one.
 *
 * Every `glyph` here is a single Unicode scalar value, which is trivially one
 * grapheme cluster — no ZWJ sequences, no skin-tone modifiers, no flags —
 * which keeps `parseIcon(glyph) === glyph` true without depending on how the
 * segmenter handles a multi-codepoint sequence. `test/icon-field.test.js`
 * checks this for every entry rather than assuming it from how the list was
 * written.
 *
 * @type {EmojiEntry[]}
 */
export const EMOJI = [
  // exercise
  { glyph: '🏃', name: 'runner', keywords: ['exercise', 'run', 'running', 'jog', 'cardio'], group: 'exercise' },
  { glyph: '🚴', name: 'cyclist', keywords: ['exercise', 'bike', 'cycling', 'ride'], group: 'exercise' },
  { glyph: '🏊', name: 'swimmer', keywords: ['exercise', 'swim', 'swimming', 'pool'], group: 'exercise' },
  { glyph: '🤸', name: 'cartwheel', keywords: ['exercise', 'gymnastics', 'tumble'], group: 'exercise' },
  { glyph: '🧗', name: 'climber', keywords: ['exercise', 'climb', 'climbing'], group: 'exercise' },
  { glyph: '🤾', name: 'handball player', keywords: ['exercise', 'handball', 'sport'], group: 'exercise' },
  { glyph: '🏓', name: 'ping pong', keywords: ['exercise', 'table tennis', 'sport'], group: 'exercise' },
  { glyph: '🏸', name: 'badminton', keywords: ['exercise', 'badminton', 'sport'], group: 'exercise' },
  { glyph: '🥊', name: 'boxing glove', keywords: ['exercise', 'boxing', 'workout'], group: 'exercise' },
  { glyph: '⚽', name: 'soccer ball', keywords: ['exercise', 'soccer', 'football', 'sport'], group: 'exercise' },
  { glyph: '🏀', name: 'basketball', keywords: ['exercise', 'basketball', 'sport'], group: 'exercise' },
  { glyph: '🤺', name: 'fencer', keywords: ['exercise', 'fencing', 'sport'], group: 'exercise' },
  { glyph: '🏹', name: 'bow and arrow', keywords: ['exercise', 'archery', 'sport'], group: 'exercise' },
  { glyph: '🏋', name: 'weightlifter', keywords: ['exercise', 'gym', 'lift', 'weights', 'workout'], group: 'exercise' },
  { glyph: '🤽', name: 'water polo', keywords: ['exercise', 'polo', 'sport'], group: 'exercise' },
  { glyph: '🚣', name: 'rowboat', keywords: ['exercise', 'row', 'rowing'], group: 'exercise' },

  // food
  { glyph: '🍎', name: 'red apple', keywords: ['food', 'apple', 'fruit', 'eat'], group: 'food' },
  { glyph: '🍕', name: 'pizza', keywords: ['food', 'pizza', 'eat'], group: 'food' },
  { glyph: '🥗', name: 'green salad', keywords: ['food', 'salad', 'vegetables', 'eat', 'healthy'], group: 'food' },
  { glyph: '🍳', name: 'fried egg', keywords: ['food', 'egg', 'breakfast', 'cook'], group: 'food' },
  { glyph: '🍞', name: 'bread', keywords: ['food', 'bread', 'bake'], group: 'food' },
  { glyph: '🍇', name: 'grapes', keywords: ['food', 'grapes', 'fruit'], group: 'food' },
  { glyph: '🥑', name: 'avocado', keywords: ['food', 'avocado', 'fruit'], group: 'food' },
  { glyph: '🍔', name: 'hamburger', keywords: ['food', 'burger', 'eat'], group: 'food' },
  { glyph: '🥦', name: 'broccoli', keywords: ['food', 'broccoli', 'vegetable'], group: 'food' },
  { glyph: '🍜', name: 'noodles', keywords: ['food', 'noodles', 'ramen', 'eat'], group: 'food' },
  { glyph: '🍩', name: 'doughnut', keywords: ['food', 'donut', 'doughnut', 'snack'], group: 'food' },
  { glyph: '🍰', name: 'shortcake', keywords: ['food', 'cake', 'dessert'], group: 'food' },
  { glyph: '🥕', name: 'carrot', keywords: ['food', 'carrot', 'vegetable'], group: 'food' },
  { glyph: '🍌', name: 'banana', keywords: ['food', 'banana', 'fruit'], group: 'food' },
  { glyph: '🍚', name: 'cooked rice', keywords: ['food', 'rice', 'eat'], group: 'food' },
  { glyph: '🥩', name: 'cut of meat', keywords: ['food', 'meat', 'steak', 'protein'], group: 'food' },

  // water
  { glyph: '💧', name: 'droplet', keywords: ['water', 'drink', 'hydrate', 'hydration'], group: 'water' },
  { glyph: '🚰', name: 'potable water', keywords: ['water', 'drink', 'fountain', 'tap'], group: 'water' },
  { glyph: '🥤', name: 'cup with straw', keywords: ['water', 'drink', 'cup'], group: 'water' },
  { glyph: '🌊', name: 'water wave', keywords: ['water', 'wave', 'ocean'], group: 'water' },
  { glyph: '🧊', name: 'ice cube', keywords: ['water', 'ice', 'cold'], group: 'water' },
  { glyph: '🚿', name: 'shower', keywords: ['water', 'shower', 'wash'], group: 'water' },
  { glyph: '🛁', name: 'bathtub', keywords: ['water', 'bath', 'wash'], group: 'water' },
  { glyph: '💦', name: 'sweat droplets', keywords: ['water', 'splash', 'sweat'], group: 'water' },
  { glyph: '⛲', name: 'fountain', keywords: ['water', 'fountain'], group: 'water' },
  { glyph: '🫗', name: 'pouring liquid', keywords: ['water', 'pour', 'drink'], group: 'water' },

  // sleep
  { glyph: '😴', name: 'sleeping face', keywords: ['sleep', 'nap', 'rest', 'bedtime'], group: 'sleep' },
  { glyph: '🛌', name: 'person in bed', keywords: ['sleep', 'bed', 'rest'], group: 'sleep' },
  { glyph: '🛏', name: 'bed', keywords: ['sleep', 'bed', 'bedroom'], group: 'sleep' },
  { glyph: '💤', name: 'zzz', keywords: ['sleep', 'nap', 'snore'], group: 'sleep' },
  { glyph: '🌙', name: 'crescent moon', keywords: ['sleep', 'night', 'moon', 'bedtime'], group: 'sleep' },
  { glyph: '🌛', name: 'first quarter moon face', keywords: ['sleep', 'night', 'moon'], group: 'sleep' },
  { glyph: '🌜', name: 'last quarter moon face', keywords: ['sleep', 'night', 'moon'], group: 'sleep' },
  { glyph: '😪', name: 'sleepy face', keywords: ['sleep', 'tired', 'drowsy'], group: 'sleep' },
  { glyph: '🧸', name: 'teddy bear', keywords: ['sleep', 'bedtime', 'comfort'], group: 'sleep' },
  { glyph: '⏰', name: 'alarm clock', keywords: ['sleep', 'alarm', 'wake', 'morning'], group: 'sleep' },
  { glyph: '🌃', name: 'night with stars', keywords: ['sleep', 'night', 'bedtime'], group: 'sleep' },

  // reading
  { glyph: '📖', name: 'open book', keywords: ['reading', 'book', 'read'], group: 'reading' },
  { glyph: '📚', name: 'books', keywords: ['reading', 'books', 'library', 'read'], group: 'reading' },
  { glyph: '📕', name: 'closed book, red cover', keywords: ['reading', 'book', 'read'], group: 'reading' },
  { glyph: '📗', name: 'closed book, green cover', keywords: ['reading', 'book', 'read'], group: 'reading' },
  { glyph: '📘', name: 'closed book, blue cover', keywords: ['reading', 'book', 'read'], group: 'reading' },
  { glyph: '📙', name: 'closed book, orange cover', keywords: ['reading', 'book', 'read'], group: 'reading' },
  { glyph: '🔖', name: 'bookmark', keywords: ['reading', 'bookmark', 'book'], group: 'reading' },
  { glyph: '📰', name: 'newspaper', keywords: ['reading', 'news', 'newspaper'], group: 'reading' },
  { glyph: '🗞', name: 'rolled-up newspaper', keywords: ['reading', 'news', 'newspaper'], group: 'reading' },
  { glyph: '📓', name: 'notebook', keywords: ['reading', 'notebook', 'journal'], group: 'reading' },
  { glyph: '📒', name: 'ledger', keywords: ['reading', 'ledger', 'notebook'], group: 'reading' },
  { glyph: '🤓', name: 'nerd face', keywords: ['reading', 'study', 'book'], group: 'reading' },

  // money
  { glyph: '💰', name: 'money bag', keywords: ['money', 'savings', 'cash'], group: 'money' },
  { glyph: '💵', name: 'dollar banknote', keywords: ['money', 'dollar', 'cash', 'budget'], group: 'money' },
  { glyph: '💴', name: 'yen banknote', keywords: ['money', 'yen', 'cash'], group: 'money' },
  { glyph: '💶', name: 'euro banknote', keywords: ['money', 'euro', 'cash'], group: 'money' },
  { glyph: '💷', name: 'pound banknote', keywords: ['money', 'pound', 'cash'], group: 'money' },
  { glyph: '🪙', name: 'coin', keywords: ['money', 'coin', 'savings'], group: 'money' },
  { glyph: '💳', name: 'credit card', keywords: ['money', 'card', 'budget', 'spend'], group: 'money' },
  { glyph: '🏦', name: 'bank', keywords: ['money', 'bank', 'savings'], group: 'money' },
  { glyph: '📈', name: 'chart increasing', keywords: ['money', 'invest', 'growth'], group: 'money' },
  { glyph: '📉', name: 'chart decreasing', keywords: ['money', 'invest', 'loss', 'budget'], group: 'money' },
  { glyph: '🧾', name: 'receipt', keywords: ['money', 'receipt', 'budget', 'spend'], group: 'money' },
  { glyph: '💸', name: 'money with wings', keywords: ['money', 'spend', 'expense'], group: 'money' },

  // cleaning
  { glyph: '🧹', name: 'broom', keywords: ['cleaning', 'sweep', 'chores'], group: 'cleaning' },
  { glyph: '🧺', name: 'basket', keywords: ['cleaning', 'laundry', 'chores'], group: 'cleaning' },
  { glyph: '🧽', name: 'sponge', keywords: ['cleaning', 'wash', 'chores'], group: 'cleaning' },
  { glyph: '🧼', name: 'soap', keywords: ['cleaning', 'wash', 'chores'], group: 'cleaning' },
  { glyph: '🪣', name: 'bucket', keywords: ['cleaning', 'mop', 'chores'], group: 'cleaning' },
  { glyph: '🧴', name: 'lotion bottle', keywords: ['cleaning', 'detergent', 'chores'], group: 'cleaning' },
  { glyph: '🗑', name: 'wastebasket', keywords: ['cleaning', 'trash', 'garbage', 'chores'], group: 'cleaning' },
  { glyph: '🧻', name: 'roll of paper', keywords: ['cleaning', 'paper towel', 'chores'], group: 'cleaning' },
  { glyph: '🪠', name: 'plunger', keywords: ['cleaning', 'chores'], group: 'cleaning' },
  { glyph: '🧯', name: 'fire extinguisher', keywords: ['cleaning', 'safety', 'chores'], group: 'cleaning' },
  { glyph: '🪟', name: 'window', keywords: ['cleaning', 'window', 'chores'], group: 'cleaning' },
  { glyph: '🫧', name: 'bubbles', keywords: ['cleaning', 'wash', 'chores'], group: 'cleaning' },

  // meditation
  { glyph: '🧘', name: 'person in lotus position', keywords: ['meditation', 'meditate', 'yoga', 'calm'], group: 'meditation' },
  { glyph: '🕉', name: 'om', keywords: ['meditation', 'om', 'mindfulness'], group: 'meditation' },
  { glyph: '☮', name: 'peace symbol', keywords: ['meditation', 'peace', 'calm'], group: 'meditation' },
  { glyph: '🙏', name: 'folded hands', keywords: ['meditation', 'gratitude', 'prayer', 'calm'], group: 'meditation' },
  { glyph: '🌸', name: 'cherry blossom', keywords: ['meditation', 'calm', 'mindfulness'], group: 'meditation' },
  { glyph: '🕯', name: 'candle', keywords: ['meditation', 'calm', 'mindfulness'], group: 'meditation' },
  { glyph: '🪷', name: 'lotus', keywords: ['meditation', 'lotus', 'calm'], group: 'meditation' },
  { glyph: '🧠', name: 'brain', keywords: ['meditation', 'mindfulness', 'mental'], group: 'meditation' },
  { glyph: '🌿', name: 'herb', keywords: ['meditation', 'calm', 'nature'], group: 'meditation' },
  { glyph: '🍃', name: 'leaf fluttering in wind', keywords: ['meditation', 'calm', 'breathe'], group: 'meditation' },
  { glyph: '☯', name: 'yin yang', keywords: ['meditation', 'balance', 'calm'], group: 'meditation' },
  { glyph: '🔔', name: 'bell', keywords: ['meditation', 'mindfulness', 'chime'], group: 'meditation' },

  // medication
  { glyph: '💊', name: 'pill', keywords: ['medication', 'medicine', 'pill', 'vitamin'], group: 'medication' },
  { glyph: '💉', name: 'syringe', keywords: ['medication', 'injection', 'shot', 'medicine'], group: 'medication' },
  { glyph: '🩹', name: 'adhesive bandage', keywords: ['medication', 'bandage', 'first aid'], group: 'medication' },
  { glyph: '🩺', name: 'stethoscope', keywords: ['medication', 'doctor', 'health'], group: 'medication' },
  { glyph: '🌡', name: 'thermometer', keywords: ['medication', 'fever', 'temperature', 'health'], group: 'medication' },
  { glyph: '🏥', name: 'hospital', keywords: ['medication', 'hospital', 'health'], group: 'medication' },
  { glyph: '🦷', name: 'tooth', keywords: ['medication', 'dental', 'teeth', 'health'], group: 'medication' },
  { glyph: '🩻', name: 'x-ray', keywords: ['medication', 'x-ray', 'health'], group: 'medication' },
  { glyph: '🧬', name: 'dna', keywords: ['medication', 'dna', 'health'], group: 'medication' },
  { glyph: '🧪', name: 'test tube', keywords: ['medication', 'lab', 'health'], group: 'medication' },

  // study
  { glyph: '📝', name: 'memo', keywords: ['study', 'notes', 'write', 'homework'], group: 'study' },
  { glyph: '✏', name: 'pencil', keywords: ['study', 'write', 'homework'], group: 'study' },
  { glyph: '🖊', name: 'pen', keywords: ['study', 'write', 'homework'], group: 'study' },
  { glyph: '📐', name: 'triangular ruler', keywords: ['study', 'math', 'homework'], group: 'study' },
  { glyph: '📏', name: 'straight ruler', keywords: ['study', 'measure', 'homework'], group: 'study' },
  { glyph: '🎓', name: 'graduation cap', keywords: ['study', 'school', 'graduate', 'learn'], group: 'study' },
  { glyph: '🧮', name: 'abacus', keywords: ['study', 'math', 'homework'], group: 'study' },
  { glyph: '📊', name: 'bar chart', keywords: ['study', 'data', 'homework'], group: 'study' },
  { glyph: '🔬', name: 'microscope', keywords: ['study', 'science', 'homework'], group: 'study' },
  { glyph: '🏫', name: 'school', keywords: ['study', 'school', 'class'], group: 'study' },
  { glyph: '📔', name: 'notebook with decorative cover', keywords: ['study', 'notes', 'journal'], group: 'study' },
  { glyph: '🗂', name: 'card index dividers', keywords: ['study', 'organize', 'notes'], group: 'study' },

  // music
  { glyph: '🎵', name: 'musical note', keywords: ['music', 'song', 'practice'], group: 'music' },
  { glyph: '🎶', name: 'musical notes', keywords: ['music', 'song', 'practice'], group: 'music' },
  { glyph: '🎸', name: 'guitar', keywords: ['music', 'guitar', 'practice'], group: 'music' },
  { glyph: '🎹', name: 'musical keyboard', keywords: ['music', 'piano', 'practice'], group: 'music' },
  { glyph: '🎺', name: 'trumpet', keywords: ['music', 'trumpet', 'practice'], group: 'music' },
  { glyph: '🎻', name: 'violin', keywords: ['music', 'violin', 'practice'], group: 'music' },
  { glyph: '🥁', name: 'drum', keywords: ['music', 'drums', 'practice'], group: 'music' },
  { glyph: '🎤', name: 'microphone', keywords: ['music', 'sing', 'practice'], group: 'music' },
  { glyph: '🎧', name: 'headphone', keywords: ['music', 'listen', 'practice'], group: 'music' },
  { glyph: '📻', name: 'radio', keywords: ['music', 'radio', 'listen'], group: 'music' },
  { glyph: '🪘', name: 'long drum', keywords: ['music', 'drum', 'practice'], group: 'music' },
  { glyph: '🎼', name: 'musical score', keywords: ['music', 'compose', 'practice'], group: 'music' },

  // code
  { glyph: '💻', name: 'laptop', keywords: ['code', 'coding', 'programming', 'develop'], group: 'code' },
  { glyph: '⌨', name: 'keyboard', keywords: ['code', 'type', 'programming'], group: 'code' },
  { glyph: '🖥', name: 'desktop computer', keywords: ['code', 'programming', 'develop'], group: 'code' },
  { glyph: '🖱', name: 'computer mouse', keywords: ['code', 'programming'], group: 'code' },
  { glyph: '🐛', name: 'bug', keywords: ['code', 'bug', 'debug', 'programming'], group: 'code' },
  { glyph: '🔧', name: 'wrench', keywords: ['code', 'fix', 'tool'], group: 'code' },
  { glyph: '⚙', name: 'gear', keywords: ['code', 'settings', 'tool'], group: 'code' },
  { glyph: '🧩', name: 'puzzle piece', keywords: ['code', 'solve', 'programming'], group: 'code' },
  { glyph: '🗄', name: 'file cabinet', keywords: ['code', 'files', 'data'], group: 'code' },
  { glyph: '💾', name: 'floppy disk', keywords: ['code', 'save', 'data'], group: 'code' },
  { glyph: '🔌', name: 'electric plug', keywords: ['code', 'connect', 'plugin'], group: 'code' },

  // outdoors
  { glyph: '🌲', name: 'evergreen tree', keywords: ['outdoors', 'nature', 'forest', 'hike'], group: 'outdoors' },
  { glyph: '🌳', name: 'deciduous tree', keywords: ['outdoors', 'nature', 'park'], group: 'outdoors' },
  { glyph: '🏔', name: 'snow-capped mountain', keywords: ['outdoors', 'mountain', 'hike'], group: 'outdoors' },
  { glyph: '⛺', name: 'tent', keywords: ['outdoors', 'camp', 'camping'], group: 'outdoors' },
  { glyph: '🏕', name: 'camping', keywords: ['outdoors', 'camp', 'camping'], group: 'outdoors' },
  { glyph: '🥾', name: 'hiking boot', keywords: ['outdoors', 'hike', 'hiking', 'walk'], group: 'outdoors' },
  { glyph: '🌄', name: 'sunrise over mountains', keywords: ['outdoors', 'sunrise', 'hike'], group: 'outdoors' },
  { glyph: '🌅', name: 'sunrise', keywords: ['outdoors', 'sunrise', 'morning'], group: 'outdoors' },
  { glyph: '🍂', name: 'fallen leaf', keywords: ['outdoors', 'autumn', 'nature'], group: 'outdoors' },
  { glyph: '🌻', name: 'sunflower', keywords: ['outdoors', 'garden', 'nature'], group: 'outdoors' },
  { glyph: '🐿', name: 'chipmunk', keywords: ['outdoors', 'nature', 'wildlife'], group: 'outdoors' },
  { glyph: '🦋', name: 'butterfly', keywords: ['outdoors', 'nature', 'wildlife'], group: 'outdoors' },

  // social
  { glyph: '👥', name: 'busts in silhouette', keywords: ['social', 'friends', 'people'], group: 'social' },
  { glyph: '👋', name: 'waving hand', keywords: ['social', 'greet', 'hello'], group: 'social' },
  { glyph: '🤝', name: 'handshake', keywords: ['social', 'meet', 'deal'], group: 'social' },
  { glyph: '💬', name: 'speech balloon', keywords: ['social', 'chat', 'talk'], group: 'social' },
  { glyph: '🎉', name: 'party popper', keywords: ['social', 'party', 'celebrate'], group: 'social' },
  { glyph: '🥳', name: 'partying face', keywords: ['social', 'party', 'celebrate'], group: 'social' },
  { glyph: '📞', name: 'telephone receiver', keywords: ['social', 'call', 'phone'], group: 'social' },
  { glyph: '☎', name: 'telephone', keywords: ['social', 'call', 'phone'], group: 'social' },
  { glyph: '📱', name: 'mobile phone', keywords: ['social', 'call', 'text', 'phone'], group: 'social' },
  { glyph: '🎂', name: 'birthday cake', keywords: ['social', 'birthday', 'celebrate'], group: 'social' },
  { glyph: '🍻', name: 'clinking beer mugs', keywords: ['social', 'friends', 'cheers'], group: 'social' },
  { glyph: '🎊', name: 'confetti ball', keywords: ['social', 'party', 'celebrate'], group: 'social' },

  // no-smoking
  { glyph: '🚭', name: 'no smoking', keywords: ['no-smoking', 'smoking', 'quit', 'cigarette'], group: 'no-smoking' },
  { glyph: '🛑', name: 'stop sign', keywords: ['no-smoking', 'stop', 'quit'], group: 'no-smoking' },
  { glyph: '❌', name: 'cross mark', keywords: ['no-smoking', 'avoid', 'no'], group: 'no-smoking' },
  { glyph: '🙅', name: 'person gesturing no', keywords: ['no-smoking', 'no', 'refuse'], group: 'no-smoking' },
  { glyph: '🫁', name: 'lungs', keywords: ['no-smoking', 'lungs', 'breathe', 'quit smoking'], group: 'no-smoking' },
  { glyph: '🌬', name: 'wind face', keywords: ['no-smoking', 'fresh air', 'breathe'], group: 'no-smoking' },

  // no-alcohol
  { glyph: '🚱', name: 'non-potable water', keywords: ['no-alcohol', 'sober', 'quit drinking'], group: 'no-alcohol' },
  { glyph: '🧃', name: 'beverage box', keywords: ['no-alcohol', 'juice', 'alternative'], group: 'no-alcohol' },
  { glyph: '🍵', name: 'teacup without handle', keywords: ['no-alcohol', 'tea', 'alternative'], group: 'no-alcohol' },
  { glyph: '🥛', name: 'glass of milk', keywords: ['no-alcohol', 'milk', 'alternative'], group: 'no-alcohol' },
  { glyph: '🫖', name: 'teapot', keywords: ['no-alcohol', 'tea', 'alternative'], group: 'no-alcohol' },
  { glyph: '🚫', name: 'prohibited', keywords: ['no-alcohol', 'sober', 'quit drinking', 'alcohol'], group: 'no-alcohol' },
];

/**
 * Module-scoped, like `shared/src/validate.js:108-111`'s own segmenter —
 * constructing an `Intl.Segmenter` is not free, and unlike `parseIcon`, which
 * runs once per write, `previewIcon` below runs on every keystroke in the
 * icon field.
 */
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * `parseIcon`'s derivation, DUPLICATED for display only.
 *
 * This is a deliberate second declaration, not a drift risk left alone: this
 * file is served to the browser and `shared/src` is not, exactly the
 * `ui/values.js` ↔ `src/constants.js` arrangement (and `CHANNELS`'s) one
 * level up. `test/icon-field.test.js` pins this function against `parseIcon`
 * behaviourally, over the same example table, so the two cannot quietly
 * diverge.
 *
 * This decides what is DISPLAYED in the preview and NOTHING about what is
 * STORED — the field still sends its raw text, `parseIcon` on the server is
 * still the only authority on what a habit's icon becomes, and this must stay
 * exactly as permissive (any grapheme, not only pictographic ones) and exactly
 * as strict (one grapheme, dropped past `LIMITS.icon` UTF-16 units) as that
 * function, or the preview lies about what Save will do.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function previewIcon(text) {
  const cleaned = String(text ?? '')
    .replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, '')
    .trim();
  if (!cleaned) return '';

  const first = SEGMENTER.segment(cleaned)[Symbol.iterator]().next().value;
  const grapheme = first ? first.segment : '';
  // 32 UTF-16 units — LIMITS.icon in shared/src/validate.js, duplicated as a
  // literal for the reason above: this file cannot import that module.
  return grapheme.length > 32 ? '' : grapheme;
}

/**
 * Trimmed, case-folded substring match over `name` and `keywords`. No index —
 * the dataset is a few hundred entries, small enough that a full scan on
 * every keystroke is free, and an index is exactly the complexity the scope
 * call in the brief rules out.
 *
 * @param {string} query
 * @returns {EmojiEntry[]}
 */
export function searchEmoji(query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return EMOJI.slice();
  return EMOJI.filter((e) =>
    e.name.toLowerCase().includes(q) || e.keywords.some((k) => k.toLowerCase().includes(q))
  );
}

/* ---------- the DOM half: `#icon-*` inside `#habit-dialog` ---------- */

/**
 * Set once by `initIconField()`, never at module scope — see the file header.
 * @type {{
 *   input: HTMLInputElement, glyph: HTMLElement, caption: HTMLElement,
 *   toggle: HTMLButtonElement, panel: HTMLElement, search: HTMLInputElement,
 *   grid: HTMLElement, dialog: Element,
 * } | null}
 */
let els = null;

/** Redraw the glyph and the caption from what the field currently holds. */
function updatePreview() {
  const p = previewIcon(els.input.value);
  // aria-hidden — an emoji announces as its Unicode name, which is exactly
  // what the caption beside it (aria-live) exists to replace. See the CLAUDE.md
  // note on this field for why both exist.
  els.glyph.textContent = p;
  els.caption.textContent = p ? `Will be saved as: ${p}` : 'Nothing will be saved';
}

/** Every `.icon-cell` currently in the grid, in document order. */
function cells() {
  return /** @type {NodeListOf<HTMLButtonElement>} */ (els.grid.querySelectorAll('.icon-cell'));
}

/**
 * Exactly one cell carries `tabindex="0"`; the rest carry `-1`.
 * @param {HTMLButtonElement} cell
 */
function setRovingFocus(cell) {
  for (const c of cells()) c.tabIndex = c === cell ? 0 : -1;
}

/**
 * How many columns the grid is actually drawing right now. The grid is
 * `repeat(auto-fill, minmax(...))`, so the count is a function of the
 * rendered width and not something a fixed constant could answer — read back
 * from the layout the browser already computed rather than re-deriving it.
 */
function gridColumns() {
  const template = getComputedStyle(els.grid).gridTemplateColumns.trim();
  return template ? template.split(/\s+/).length : 1;
}

/**
 * ArrowLeft/Right move by one cell, ArrowUp/Down by a row (the column count),
 * Home/End to the ends of the grid — `charts.js`'s `handleGridKey` is the
 * precedent this follows: movement is clamped by looking the target cell up
 * and doing nothing when there is none, and an unhandled key returns before
 * `preventDefault()` so it keeps its ordinary behaviour (Tab, Shift+Tab, …).
 *
 * @param {KeyboardEvent} e
 * @param {HTMLButtonElement} cell
 */
function handleGridKey(e, cell) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    pickGlyph(cell.textContent);
    return;
  }

  const list = [...cells()];
  const idx = list.indexOf(cell);
  const columns = gridColumns();
  let target;
  if (e.key === 'ArrowLeft') target = idx - 1;
  else if (e.key === 'ArrowRight') target = idx + 1;
  else if (e.key === 'ArrowUp') target = idx - columns;
  else if (e.key === 'ArrowDown') target = idx + columns;
  else if (e.key === 'Home') target = 0;
  else if (e.key === 'End') target = list.length - 1;
  else return;

  e.preventDefault();
  const next = list[target];
  if (!next) return;
  setRovingFocus(next);
  next.focus();
}

/**
 * Rebuild the grid from a list of entries. Called on open and on every
 * `#icon-search` keystroke, and resets the roving tab stop to the first cell
 * of whatever is now visible — the previous tab stop may not even be in the
 * new list.
 */
function renderGrid(entries) {
  els.grid.replaceChildren();
  entries.forEach((entry, i) => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'icon-cell';
    cell.textContent = entry.glyph;
    // The one place an emoji's name is wanted rather than hidden — see the
    // dataset's own doc comment.
    cell.setAttribute('aria-label', entry.name);
    cell.tabIndex = i === 0 ? 0 : -1;
    cell.addEventListener('click', () => pickGlyph(entry.glyph));
    cell.addEventListener('keydown', (e) => handleGridKey(e, cell));
    els.grid.append(cell);
  });
}

/**
 * Write the field, and nothing else — no hidden input, no module-level
 * "selected" state that `iconField.value()` reads instead. A later tier
 * (#66 tier 2) is a different field, not a magic string smuggled through this
 * one.
 */
function pickGlyph(glyph) {
  els.input.value = glyph;
  updatePreview();
  els.input.focus();
  closePanel();
}

function openPanel() {
  els.panel.hidden = false;
  els.toggle.setAttribute('aria-expanded', 'true');
  els.search.value = '';
  renderGrid(EMOJI);
}

function closePanel() {
  els.panel.hidden = true;
  els.toggle.setAttribute('aria-expanded', 'false');
}

/**
 * Return the panel and its search to their closed, unfiltered state.
 *
 * `#icon-picker` is static markup, wired once by `initIconField()` — nothing
 * about a habit dialog session tears it down or rebuilds it — so without
 * this, a panel left open (and a search query left typed) in one session was
 * still open and still filtering the grid the NEXT time the dialog opened,
 * for a different habit. Called from `iconField.set()`, which
 * `habit-dialog.js`'s `openDialog` already calls for every session (create or
 * edit), so this is the one seam a dialog open always passes through.
 */
function reset() {
  closePanel();
  els.search.value = '';
  renderGrid(EMOJI);
}

/**
 * `iconField.set` / `iconField.value` mirror `reminderField`'s own pair.
 * `value()` returns the input's RAW text — it must never run `previewIcon`,
 * which decides only what is shown, not what `saveHabit` sends.
 */
export const iconField = {
  set(value) {
    els.input.value = value ?? '';
    reset();
    updatePreview();
  },
  value() {
    return els.input.value;
  },
};

/**
 * Wire the `#icon-*` controls inside `#habit-dialog`. Called once, from
 * `habit-dialog.js`'s own module scope — which already touches the DOM at
 * import — never from inside this file, so importing `icon-field.js` under
 * Node (`test/icon-field.test.js`) touches no `document` unless this function
 * is actually called, which that test never does.
 *
 * @param {Element} dialogEl `#habit-dialog` itself, HANDED IN rather than
 *   looked up: `#habit-dialog` is `habit-dialog.js`'s own id and naming it
 *   here would give it two owners (`test/ui-modules.test.js`), exactly the
 *   reason the input below is found by its `name` and not `#habit-form
 *   input[...]`. The element is needed, not the id, for the Escape handler
 *   below.
 */
export function initIconField(dialogEl) {
  els = {
    // Not `#habit-form input[...]` — `#habit-form` is `habit-dialog.js`'s own
    // id, and naming it here would give it two owners
    // (`test/ui-modules.test.js`). The name attribute is this field's own.
    input: /** @type {HTMLInputElement} */ (document.querySelector('input[name="icon"]')),
    glyph: document.querySelector('#icon-preview .icon-preview-glyph'),
    caption: document.querySelector('#icon-preview .icon-preview-caption'),
    toggle: /** @type {HTMLButtonElement} */ (document.getElementById('icon-picker-toggle')),
    panel: document.getElementById('icon-picker'),
    search: /** @type {HTMLInputElement} */ (document.getElementById('icon-search')),
    grid: document.getElementById('icon-grid'),
    dialog: dialogEl,
  };

  els.input.addEventListener('input', updatePreview);

  els.toggle.addEventListener('click', () => {
    if (els.panel.hidden) openPanel(); else closePanel();
  });

  els.search.addEventListener('input', () => renderGrid(searchEmoji(els.search.value)));

  // Enter in the search box means "pick the first match", never the habit
  // form's Save — the same implicit-submission trap `enterPresses`
  // (habit-dialog.js) exists for, over a box this module owns instead. A box
  // where Enter does nothing is its own bug report, so this picks rather than
  // merely swallowing the key.
  els.search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const first = /** @type {HTMLButtonElement | null} */ (els.grid.querySelector('.icon-cell'));
    if (first) first.click();
  });

  // Escape closes the panel, not the dialog behind it — bound on the DIALOG,
  // not `els.panel`. `#icon-picker-toggle` sits in `.icon-field-row` beside
  // the input and `#icon-picker` is a sibling AFTER the whole `.icon-field`
  // block — the toggle is OUTSIDE the panel either way, which is the part
  // that matters — and `openPanel()` deliberately does
  // not move focus into the panel (a user can Shift+Tab back out of it onto
  // the toggle at any point, so stealing focus on open would only narrow this
  // hole, not close it) — so a panel opened by CLICKING the toggle leaves
  // focus on the toggle, outside `#icon-picker`, and a listener scoped to the
  // panel never runs. Guarded on `!els.panel.hidden` so every other Escape
  // press still reaches the dialog's own close. `preventDefault` is what is
  // load bearing here, not `stopPropagation`: `<dialog>`'s Escape-close is not
  // a bubbling keydown listener a `stopPropagation` could intercept, it is the
  // keydown's OWN DEFAULT ACTION (a close watcher that cancels the dialog
  // unless the keydown arrived with its default already prevented) — so
  // without `preventDefault` the first Escape a user presses to dismiss the
  // picker closes the whole habit dialog too, `stopPropagation`
  // notwithstanding. Both calls stay: `preventDefault` stops the dialog
  // closing, `stopPropagation` is harmless insurance against some other
  // ancestor listener also reacting to the key.
  els.dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || els.panel.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    closePanel();
    els.toggle.focus();
  });

  updatePreview();
}
