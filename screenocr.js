import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from "gi://GLib";
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import Shell from 'gi://Shell';

export class ScreenOCR {
  constructor() {
    this._imageFile = null;
    this._textFile = null;
  }

  _sendNotification(title, message) {
    try {
      Main.notify(title, message);
    } catch (e) {
      log(`Error while trying to send a notification: ${e.message}`);
    }
  }

  async _runCommandAsync(command, args, input = null) {
    return new Promise((resolve, reject) => {
      try {
        const proc = Gio.Subprocess.new(
          [command, ...args],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE | (input ? Gio.SubprocessFlags.STDIN_PIPE : 0)
        );

        proc.communicate_utf8_async(input, null, (proc, result) => {
          try {
            const [_, stdout, stderr] = proc.communicate_utf8_finish(result);
            if (!proc.get_successful()) {
              reject(new Error(`Command ${command} has failed: ${stderr}`));
            }
            resolve(stdout);
          } catch (e) {
            reject(e);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async _createTempFiles() {
    try {
      this._imageFile = Gio.File.new_tmp('XXXXXX.png')[0];
      this._textFile = Gio.File.new_tmp('XXXXXX.txt')[0];
    } catch (e) {
      throw new Error(`Unable to create temporary files: ${e.message}`);
    }
  }

  _selectArea() {
    return new Promise((resolve) => {
      let startX, startY;
      let selectionActor = null;
      let overlayTop = null;
      let overlayBottom = null;
      let overlayLeft = null;
      let overlayRight = null;
      let fullOverlay = null;

      global.display.set_cursor(Meta.Cursor.CROSSHAIR);

      // Initial overlay covering all the screen
      fullOverlay = new St.Widget({
        style: 'background-color: rgba(0, 0, 0, 0.5);',
        x: 0,
        y: 0,
        width: global.screen_width,
        height: global.screen_height
      });

      // Four gray rectangles around the marquise
      overlayTop = new St.Widget({
        style: 'background-color: rgba(0, 0, 0, 0.5);',
        visible: false,
        x: 0,
        y: 0,
        width: global.screen_width,
        height: 0
      });

      overlayBottom = new St.Widget({
        style: 'background-color: rgba(0, 0, 0, 0.5);',
        visible: false,
        x: 0,
        y: 0,
        width: global.screen_width,
        height: 0
      });

      overlayLeft = new St.Widget({
        style: 'background-color: rgba(0, 0, 0, 0.5);',
        visible: false,
        x: 0,
        y: 0,
        width: 0,
        height: 0
      });

      overlayRight = new St.Widget({
        style: 'background-color: rgba(0, 0, 0, 0.5);',
        visible: false,
        x: 0,
        y: 0,
        width: 0,
        height: 0
      });

      // Transparent fullscreen widget
      let captureActor = new St.Widget({
        reactive: true,
        x: 0,
        y: 0,
        width: global.screen_width,
        height: global.screen_height
      });

      // Whiete border marquise
      selectionActor = new St.Widget({
        style: 'border: 2px solid white;',
        visible: false
      });

      Main.uiGroup.add_child(fullOverlay);
      Main.uiGroup.add_child(overlayTop);
      Main.uiGroup.add_child(overlayBottom);
      Main.uiGroup.add_child(overlayLeft);
      Main.uiGroup.add_child(overlayRight);
      Main.uiGroup.add_child(captureActor);
      Main.uiGroup.add_child(selectionActor);

      const grab = Main.pushModal(captureActor);

      if (!grab) {
        console.error('Failed to grab modal');
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        [fullOverlay, overlayTop, overlayBottom, overlayLeft, overlayRight, captureActor, selectionActor].forEach(actor => {
          if (actor) {
            Main.uiGroup.remove_child(actor);
            actor.destroy();
          }
        });
        resolve([0, 0, 0, 0]);
        return;
      }

      // Update overlay function
      const updateOverlays = (x, y, width, height) => {
        // Hide full overlay for show four rectangles
        fullOverlay.hide();
        overlayTop.show();
        overlayBottom.show();
        overlayLeft.show();
        overlayRight.show();

        // Top: from 0 to y
        overlayTop.set_position(0, 0);
        overlayTop.set_size(global.screen_width, y);

        // Bottom: from y+height up to the end
        overlayBottom.set_position(0, y + height);
        overlayBottom.set_size(global.screen_width, global.screen_height - (y + height));

        // Left: frm y to y+height, from 0 à x
        overlayLeft.set_position(0, y);
        overlayLeft.set_size(x, height);

        // Right: from y to y+height, from x+width up to the end
        overlayRight.set_position(x + width, y);
        overlayRight.set_size(global.screen_width - (x + width), height);
      };

      const cleanup = () => {
        if (buttonPressId) captureActor.disconnect(buttonPressId);
        if (motionId) captureActor.disconnect(motionId);
        if (buttonReleaseId) captureActor.disconnect(buttonReleaseId);
        if (keyPressId) captureActor.disconnect(keyPressId);

        global.display.set_cursor(Meta.Cursor.DEFAULT);

        Main.popModal(grab);
        [fullOverlay, overlayTop, overlayBottom, overlayLeft, overlayRight, captureActor, selectionActor].forEach(actor => {
          if (actor) {
            Main.uiGroup.remove_child(actor);
            actor.destroy();
          }
        });
      };

      let isDrawing = false;

      let buttonPressId = captureActor.connect('button-press-event', (_actor, event) => {
        [startX, startY] = event.get_coords();
        isDrawing = true;
        selectionActor.set_position(startX, startY);
        selectionActor.set_size(0, 0);
        selectionActor.show();
        return Clutter.EVENT_STOP;
      });

      let motionId = captureActor.connect('motion-event', (_actor, event) => {
        if (!isDrawing) return Clutter.EVENT_PROPAGATE;

        const [currentX, currentY] = event.get_coords();
        const x = Math.min(startX, currentX);
        const y = Math.min(startY, currentY);
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);

        selectionActor.set_position(x, y);
        selectionActor.set_size(width, height);

        // Update the overlays to create a hole
        updateOverlays(x, y, width, height);

        return Clutter.EVENT_STOP;
      });

      let buttonReleaseId = captureActor.connect('button-release-event', (_actor, event) => {
        if (!isDrawing) {
          cleanup();
          resolve([0, 0, 0, 0]);
          return Clutter.EVENT_STOP;
        }

        const [currentX, currentY] = event.get_coords();
        const x = Math.round(Math.min(startX, currentX));
        const y = Math.round(Math.min(startY, currentY));
        const width = Math.round(Math.abs(currentX - startX));
        const height = Math.round(Math.abs(currentY - startY));

        cleanup();
        resolve([x, y, width, height]);

        return Clutter.EVENT_STOP;
      });

      let keyPressId = captureActor.connect('key-press-event', (_actor, event) => {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
          cleanup();
          resolve([0, 0, 0, 0]);
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });
    });
  }

  async _captureScreenshot(x, y, width, height) {
    const screenshot = new Shell.Screenshot();

    // Créer le stream de sortie
    const outputStream = this._imageFile.replace(
      null,
      false,
      Gio.FileCreateFlags.REPLACE_DESTINATION,
      null
    );

    return new Promise((resolve, reject) => {
      screenshot.screenshot_area(
        x, y, width, height,
        outputStream,  // Passer le stream, pas null
        (_obj, result) => {
          try {
            screenshot.screenshot_area_finish(result);
            outputStream.close(null);
            resolve();
          } catch (e) {
            outputStream.close(null);
            reject(e);
          }
        }
      );
    });
  }

  async _performOCR(languages) {
    try {
      const textFilePath = this._textFile.get_path();  // Tesseract adds .txt extension itself
      const tesseractArgs = [this._imageFile.get_path(), textFilePath.slice(0, textFilePath.length - ".txt".length)];
      if (languages) {
        tesseractArgs.push(...['-l', languages]);
      }
      await this._runCommandAsync('tesseract', tesseractArgs);

      if (!this._textFile.query_exists(null)) {
        throw new Error('No file output from Tesseract.');
      } else if (isFileEmpty(this._textFile)) {
        return false;  // OCR has failed (this is not an error)
      }
    } catch (e) {
      throw new Error(`OCR has failed: ${e.message}`);
    }
    return true;
  }

  async _copyToClipboard() {
    try {
      // Read the content of the text file
      const [success, contents] = await new Promise((resolve, reject) => {
        this._textFile.load_contents_async(null, (file, result) => {
          try {
            const [success, contents] = file.load_contents_finish(result);
            resolve([success, contents]);
          } catch (e) {
            reject(e);

            throw new Error();
          }
        });
      });

      if (!success) {
        throw new Error('Reading text file failed.');
      }

      const text = new TextDecoder().decode(contents).trim();

      St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text)
    } catch (e) {
      throw new Error(`Copy to clipboard failed: ${e.message}`);
    }
  }

  async _cleanup() {
    for (const file of [this._imageFile, this._textFile]) {
      if (file) {
        try {
          await new Promise((resolve, reject) => {
            file.delete_async(GLib.PRIORITY_DEFAULT, null, (file, result) => {
              try {
                file.delete_finish(result);
                resolve();
              } catch (e) {
                reject(e);
              }
            });
          });
        } catch (e) {
          console.warn(`Impossible to delete temporary file: ${e.message}`);
        }
      }
    }
  }

  async grabText(languages) {
    try {
      await this._createTempFiles();

      const [x, y, width, height] = await this._selectArea();

      if (width === 0 || height === 0) {
        console.log('Cancelled selection');
        await this._cleanup();
        return true;
      }

      await this._captureScreenshot(x, y, width, height);

      if (isFileEmpty(this._imageFile)) {
        await this._cleanup();
        return true;
      }

      const isOCRSuccessful = await this._performOCR(languages);
      this._sendNotification(isOCRSuccessful ? _('Text copied to the clipboard!') + ' 😀' : _('OCR failed.') + ' 🙁');
      await this._copyToClipboard();
      await this._cleanup();
      return true;
    } catch (e) {
      this._sendNotification(_('An error occurred during the OCR process.') + ' 🙁', e.message);
      log(e.message);
      await this._cleanup();
      return false;
    }
  }
}

function isFileEmpty(file) {
  return file.query_info('standard::size', 0, null).get_size() === 0;
}

