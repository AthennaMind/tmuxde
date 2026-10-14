import { PhotoUpload } from "@/components/terminal/photo-upload";
import { RecentPhotoList } from "@/components/terminal/recent-photos";
import { PanelHeader } from "./panel-header";

/** Photos saved on this machine. Reuse pastes the path into the terminal. */
export function PhotosView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Photos" />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="mb-3 flex flex-col gap-2 px-1">
          <PhotoUpload className="h-9 w-full justify-start hover:bg-accent" />
          <p className="text-sm text-muted-foreground">
            Paste a screenshot into the terminal, or upload one here. Reuse
            inserts a saved path without pressing Enter.
          </p>
        </div>
        <RecentPhotoList />
      </div>
    </div>
  );
}
