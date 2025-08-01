import type { EditorState, Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, WidgetType } from "@codemirror/view";
import {
  decoratorStateField,
  invisibleDecoration,
  isCursorInRange,
  shouldRenderWidgets,
} from "./util.ts";
import type { Client } from "../client.ts";
import {
  isLocalPath,
  resolvePath,
} from "@silverbulletmd/silverbullet/lib/resolve";
import { parseRef } from "@silverbulletmd/silverbullet/lib/page_ref";
import { mime } from "mimetypes";
import { LuaWidget } from "./lua_widget.ts";

type ContentDimensions = {
  width?: number;
  height?: number;
};

class InlineContentWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly title: string,
    readonly dim: ContentDimensions | undefined,
    readonly client: Client,
  ) {
    super();
  }

  override get estimatedHeight(): number {
    return this.client.getCachedWidgetHeight(
      `content:${this.url}`,
    );
  }

  override eq(other: InlineContentWidget) {
    return other.url === this.url && other.title === this.title &&
      JSON.stringify(other.dim) === JSON.stringify(this.dim);
  }

  toDOM() {
    const div = document.createElement("div");
    div.className = "sb-inline-content";
    div.style.display = "block";
    const mimeType = mime.getType(
      this.url.substring(this.url.lastIndexOf(".") + 1),
    );

    if (!mimeType) {
      return div;
    }

    let url = this.url;

    // If the URL is a local path, encode the : so that it's not interpreted as a protocol
    if (isLocalPath(url)) {
      url = url.replace(":", "%3A");
    }

    if (mimeType.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = this.title;
      this.setDim(img, "load");
      div.appendChild(img);
    } else if (mimeType.startsWith("video/")) {
      const video = document.createElement("video");
      video.src = url;
      video.title = this.title;
      video.controls = true;
      video.autoplay = false;
      this.setDim(video, "loadeddata");
      div.appendChild(video);
    } else if (mimeType.startsWith("audio/")) {
      const audio = document.createElement("audio");
      audio.src = url;
      audio.title = this.title;
      audio.controls = true;
      audio.autoplay = false;
      this.setDim(audio, "loadeddata");
      div.appendChild(audio);
    } else if (mimeType === "application/pdf") {
      const embed = document.createElement("object");
      embed.type = mimeType;
      embed.data = url;
      embed.style.width = "100%";
      embed.style.height = "20em";
      this.setDim(embed, "load");
      div.appendChild(embed);
    }

    return div;
  }

  setDim(el: HTMLElement, event: string) {
    const cachedContentHeight = this.client.getCachedWidgetHeight(
      `content:${this.url}`,
    );

    el.addEventListener(event, () => {
      if (el.clientHeight !== cachedContentHeight) {
        this.client.setCachedWidgetHeight(
          `content:${this.url}`,
          el.clientHeight,
        );
      }
    });

    el.style.maxWidth = "100%";

    if (this.dim) {
      if (this.dim.height) {
        el.style.height = `${this.dim.height}px`;
      }
      if (this.dim.width) {
        el.style.width = `${this.dim.width}px`;
      }
    } else if (cachedContentHeight > 0) {
      el.style.height = cachedContentHeight.toString();
    }
  }
}

// Parse an alias, possibly containing dimensions into an object
// Formats supported: "alias", "alias|100", "alias|100x200", "100", "100x200"
function parseAlias(
  text: string,
): { alias?: string; dim?: ContentDimensions } {
  let alias: string | undefined;
  let dim: ContentDimensions | undefined;
  if (text.includes("|")) {
    const [aliasPart, dimPart] = text.split("|");
    alias = aliasPart;
    const [width, height] = dimPart.split("x");
    dim = {};
    if (width) {
      dim.width = parseInt(width);
    }
    if (height) {
      dim.height = parseInt(height);
    }
  } else if (/^[x\d]/.test(text)) {
    const [width, height] = text.split("x");
    dim = {};
    if (width) {
      dim.width = parseInt(width);
    }
    if (height) {
      dim.height = parseInt(height);
    }
  } else {
    alias = text;
  }

  return { alias, dim };
}

export function inlineContentPlugin(client: Client) {
  return decoratorStateField((state: EditorState) => {
    const widgets: Range<Decoration>[] = [];
    if (!shouldRenderWidgets(client)) {
      console.info("Not rendering widgets");
      return Decoration.set([]);
    }

    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name !== "Image") {
          return;
        }

        const text = state.sliceDoc(node.from, node.to);
        let [url, alias]: (string | undefined)[] = [undefined, undefined];
        let match: RegExpExecArray | null;
        if ((match = /!?\[([^\]]*)\]\((.+)\)/g.exec(text))) {
          [/* fullMatch */, alias, url] = match;
        } else if (
          (match = /(!?\[\[)([^\]\|]+)(?:\|([^\]]+))?(\]\])/g.exec(text))
        ) {
          [/* fullMatch */, /* firstMark */ , url, alias] = match;
          url = "/" + url;
        }
        if (!url) {
          return;
        }

        let dim: ContentDimensions | undefined;
        if (alias) {
          const { alias: parsedAlias, dim: parsedDim } = parseAlias(alias);
          if (parsedAlias) {
            alias = parsedAlias;
          }
          dim = parsedDim;
        } else {
          alias = "";
        }

        if (isLocalPath(url)) {
          url = resolvePath(
            client.currentPage,
            decodeURI(url),
          );
          const pageRef = parseRef(url);
          if (
            client.clientSystem.allKnownFiles.has(pageRef.page + ".md")
          ) {
            widgets.push(
              Decoration.widget({
                widget: new LuaWidget(
                  client,
                  `widget:${client.currentPage}:${pageRef.page}`,
                  pageRef.page,
                  async (pageName) => {
                    const { text } = await client.space.readPage(pageName);
                    return {
                      _isWidget: true,
                      cssClasses: ["sb-markdown-widget-inline"],
                      markdown: text,
                    };
                  },
                  true,
                  true,
                ),
                block: true,
              }).range(node.to + 1),
            );

            if (!isCursorInRange(state, [node.from, node.to])) {
              widgets.push(invisibleDecoration.range(node.from, node.to));
            }

            return;
          }
        }

        widgets.push(
          Decoration.widget({
            widget: new InlineContentWidget(
              url,
              alias,
              dim,
              client,
            ),
            block: true,
          }).range(node.to + 1),
        );

        if (!isCursorInRange(state, [node.from, node.to])) {
          widgets.push(invisibleDecoration.range(node.from, node.to));
        }
      },
    });

    return Decoration.set(widgets, true);
  });
}
