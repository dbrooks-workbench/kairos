// Tags on an item are stored in a single `tags` extendedProperty as a list of tag
// names joined by the unit separator (which can't collide with user text). The
// name IS the tag's identity — no IDs — so items are self-describing and the tag
// set is reconstructable by walking the calendar.

const SEP = String.fromCharCode(31)

export function encodeTags(tags) {
  return (tags && tags.length) ? tags.join(SEP) : ''
}

export function decodeTags(str) {
  return str ? str.split(SEP).filter(Boolean) : []
}
