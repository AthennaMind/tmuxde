import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { router } from "@/app/router";
import { installContextMenuPolicy } from "@/app/context-menu-policy";
import "@/app/globals.css";

const removeContextMenuPolicy = installContextMenuPolicy(document);
import.meta.hot?.dispose(removeContextMenuPolicy);

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
