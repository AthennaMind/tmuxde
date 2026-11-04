//go:build integration

package machine

import (
	"context"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"tmuxde/internal/update"
)

type updateFixture struct {
	applies atomic.Int32
	stages  atomic.Int32
}

func (f *updateFixture) Info(context.Context) update.Component {
	return update.Component{Kind: "agent", Arch: "amd64"}
}

func (f *updateFixture) Stage(context.Context, string, update.Package) error {
	f.stages.Add(1)
	return nil
}

func (f *updateFixture) Apply(context.Context, string) error {
	f.applies.Add(1)
	return nil
}

func (f *updateFixture) Status(context.Context, string) (update.Result, error) {
	return update.Result{Phase: "updated"}, nil
}

func (f *updateFixture) Cancel(context.Context, string) error {
	return nil
}

func TestIntegrationUpdateStream(t *testing.T) {
	hub := NewHub(t.TempDir(), "browser-test-token")
	site := httptest.NewTLSServer(hub)
	t.Cleanup(site.Close)
	t.Cleanup(hub.Close)
	n, _ := realNode(t)
	record, token, err := Edit(hub.Dir, "add", "updater")
	if err != nil {
		t.Fatal(err)
	}
	fixture := &updateFixture{}
	info := fixture.Info(t.Context())
	agent := &Agent{
		URL:     site.URL,
		Token:   token,
		Node:    n,
		Files:   n,
		Updater: fixture,
		Info: Info{
			Hostname: "updater",
			Platform: "linux",
			Version:  "1.0.0",
			Features: []string{update.Feature},
			Update:   &info,
		},
	}
	connectAgent(t, hub, site, agent, record.ID)
	targets := hub.UpdateTargets()
	if len(targets) != 1 || targets[0].Info(t.Context()).ID != record.ID {
		t.Fatalf("inventory = %v", targets)
	}
	target := targets[0]
	result, err := target.Status(t.Context(), "transaction")
	if err != nil || result.Phase != "updated" {
		t.Fatalf("status = %+v, %v", result, err)
	}
	if err := target.Apply(t.Context(), "transaction"); err != nil {
		t.Fatal(err)
	}
	if fixture.applies.Load() != 1 {
		t.Fatal("apply was not dispatched exactly once")
	}
	pkg := update.Package{Tag: "v1.2.0", Asset: update.Asset{Size: 1}}
	if err := target.Stage(t.Context(), "transaction", pkg); err == nil {
		t.Fatal("agent accepted unsigned package")
	}
	if fixture.stages.Load() != 0 {
		t.Fatal("unsigned package reached installer")
	}
	// Rejected update stream must not disconnect machine control channel.
	if _, err := target.Status(t.Context(), "transaction"); err != nil {
		t.Fatal(err)
	}
}
