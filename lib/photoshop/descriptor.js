// Photoshop Action Descriptors ("flattened" ActionDescriptor objects): the format of an
// .abr 'desc' section, where every brush preset and its settings live. DOM-free.
//
// readDescriptor returns a plain object: {_class, [key]: value}. Values become
//   Objc / GlbO -> nested object      VlLs -> array          doub / long / comp -> number
//   UntF -> {unit, value}             TEXT -> string         bool -> boolean
//   enum -> 'Type.Value' string       tdta / alis -> bytes   type / GlbC -> {class}
//   obj  -> {ref: [...]} (references; rare in brushes)

export function readDescriptor(cur) {
  cur.unicode(); // display name of the class, usually empty
  const obj = { _class: cur.key() };
  const count = cur.u32();
  for (let i = 0; i < count; i++) {
    const key = cur.key();
    obj[key] = readValue(cur, cur.sig());
  }
  return obj;
}

/** The u32 version (always 16) that precedes a top-level descriptor. */
export function readVersionedDescriptor(cur) {
  const version = cur.u32();
  if (version !== 16) throw new Error(`descriptor version ${version} (expected 16)`);
  return readDescriptor(cur);
}

function readReference(cur) {
  const items = [];
  for (let n = cur.u32(); n > 0; n--) {
    const form = cur.sig();
    if (form === 'Idnt' || form === 'indx') { items.push({ form, value: cur.u32() }); continue; }
    cur.unicode();
    const cls = cur.key();
    if (form === 'prop') items.push({ form, class: cls, key: cur.key() });
    else if (form === 'Clss') items.push({ form, class: cls });
    else if (form === 'Enmr') items.push({ form, class: cls, value: `${cur.key()}.${cur.key()}` });
    else if (form === 'rele') items.push({ form, class: cls, value: cur.u32() });
    else if (form === 'name') items.push({ form, class: cls, value: cur.unicode() });
    else throw new Error(`descriptor reference form '${form}' at byte ${cur.offset}`);
  }
  return { ref: items };
}

function readValue(cur, type) {
  switch (type) {
    case 'Objc': case 'GlbO': return readDescriptor(cur);
    case 'VlLs': return Array.from({ length: cur.u32() }, () => readValue(cur, cur.sig()));
    case 'doub': return cur.f64();
    case 'UntF': return { unit: cur.sig(), value: cur.f64() };
    case 'UnFl': {
      const unit = cur.sig();
      return { unit, values: Array.from({ length: cur.u32() }, () => cur.f64()) };
    }
    case 'TEXT': return cur.unicode();
    case 'enum': return `${cur.key()}.${cur.key()}`;
    case 'long': return cur.i32();
    case 'comp': return cur.i64();
    case 'bool': return cur.u8() !== 0;
    case 'type': case 'GlbC': cur.unicode(); return { class: cur.key() };
    case 'tdta': case 'alis': return Uint8Array.from(cur.bytes(cur.u32()));
    case 'obj ': return readReference(cur);
    default: throw new Error(`descriptor value type '${type}' at byte ${cur.offset - 4}`);
  }
}

// Helpers for reading values out of a descriptor object.

/** A number from a plain number or a unit value; `fallback` when missing. */
export const num = (v, fallback = 0) => (typeof v === 'number' ? v : (v && typeof v.value === 'number' ? v.value : fallback));

/** A '#Prc' percentage (0-100) as a fraction. */
export const pct = (v, fallback = 0) => num(v, fallback * 100) / 100;

/** The value part of an enum ('BlnM.Mltp' -> 'Mltp'). */
export const enumValue = (v) => (typeof v === 'string' ? v.slice(v.indexOf('.') + 1) : null);
