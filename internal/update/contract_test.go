package update

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestHTTPContract(t *testing.T) {
	data, err := os.ReadFile("../../ui/src/protocol/fixtures/http/updates.json")
	if err != nil {
		t.Fatal(err)
	}
	var state Status
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	var original, roundtrip any
	if err := json.Unmarshal(data, &original); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &roundtrip); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(original, roundtrip) {
		t.Fatal("inventory contract lost or added fields")
	}
	data, err = os.ReadFile("../../ui/src/protocol/fixtures/http/update-requests.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures map[string][]json.RawMessage
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for category, samples := range fixtures {
		for _, sample := range samples {
			decoder := json.NewDecoder(bytes.NewReader(sample))
			decoder.DisallowUnknownFields()
			var request StartRequest
			err := decoder.Decode(&request)
			if err == nil {
				err = request.Validate()
			}
			if (err == nil) != (category == "valid") {
				t.Errorf("%s request %s: %v", category, sample, err)
			}
		}
	}
}
