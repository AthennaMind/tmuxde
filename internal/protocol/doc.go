// Package protocol holds what client and server messages share: the info
// structs from packages/protocol/src/types.ts, decoding, field checks,
// validation helpers and the fixture locations.
//
// Wire types live in two packages. tmuxde/internal/protocol/client has the
// messages a browser sends. tmuxde/internal/protocol/server has the messages
// the server sends. Both mirror the Zod schemas in packages/protocol/src.
//
// Rules for a wire type:
//
//   - One struct per type. The name is the type in CamelCase, so
//     file:write:result is server.FileWriteResult.
//   - The first field is Type string `json:"type"`.
//   - Validate mirrors every Zod constraint: lengths, patterns, ranges,
//     enums. Never looser.
//   - z.number() is float64. z.number().int() is int.
//   - A field without omitempty is required. Decode refuses a message when
//     the key is missing or null.
//   - An optional field uses omitempty. Use a pointer when the zero value is
//     a valid wire value, so false, 0 and "" survive a round trip.
//   - A nullable field that is not optional is a pointer without omitempty.
//     It is the only kind of field that accepts null.
//
// Every wire type has a fixture in packages/protocol/fixtures. The contract
// tests in this directory check fixtures, registries and the type list
// against the TypeScript sources. Constrained fields also have samples in
// packages/protocol/fixtures/invalid. Zod and Decode must both refuse each
// one for the field it names. Add one there for every new constraint.
package protocol
