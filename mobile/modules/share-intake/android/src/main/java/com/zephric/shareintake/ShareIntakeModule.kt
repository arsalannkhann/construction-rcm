package com.zephric.shareintake

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.UUID

/**
 * Files shared to Zephric from another app (Android's Share sheet, declared by
 * the SEND and SEND_MULTIPLE intent filters in app.json).
 *
 * The other app's permission to read a shared file lasts only as long as
 * Zephric's activity, so `take` copies each file into the app's cache straight
 * away and hands JavaScript plain file paths. Only content:// addresses
 * belonging to other apps are read: a file:// address, or one of Zephric's own
 * providers, could point at Zephric's private files.
 */
class ShareIntakeModule : Module() {
  private data class Received(val uris: List<Uri>, val type: String?)

  private val lock = Any()
  /** A share that arrived while the app was open, waiting for JavaScript to take it. */
  private var waiting: Received? = null
  /** The intent already taken, so the same share is never added twice. */
  private var taken: Intent? = null

  override fun definition() = ModuleDefinition {
    Name("ZephricShareIntake")
    Events("onShare")

    OnNewIntent { intent ->
      val received = read(intent) ?: return@OnNewIntent
      synchronized(lock) {
        waiting = received
        taken = intent
      }
      sendEvent("onShare")
    }

    // Copies the waiting share (or the one that opened the app) and returns
    // { files: [{ uri, name, mimeType, size, status }], overLimit }.
    AsyncFunction("take") { maxFiles: Int, maxBytes: Double ->
      val received = synchronized(lock) { waiting.also { waiting = null } } ?: fromLaunch()
      if (received == null) {
        mapOf("files" to emptyList<Map<String, Any?>>(), "overLimit" to 0)
      } else {
        copyAll(received, maxFiles.coerceAtLeast(0), maxBytes.toLong())
      }
    }
  }

  private fun fromLaunch(): Received? {
    val intent = appContext.currentActivity?.intent ?: return null
    // Reopened from the recent-apps screen: the share was handled the first time.
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
    synchronized(lock) {
      if (taken === intent) return null
      val received = read(intent) ?: return null
      taken = intent
      return received
    }
  }

  private fun read(intent: Intent): Received? {
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null
    val uris = mutableListOf<Uri>()
    if (action == Intent.ACTION_SEND) {
      streamOf(intent)?.let { uris.add(it) }
    } else {
      uris.addAll(streamsOf(intent))
    }
    // Some apps put the files only in the clip data.
    if (uris.isEmpty()) {
      intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) } }
    }
    val context = appContext.reactContext ?: return null
    val allowed = uris.distinct().filter { isOtherAppsContent(context, it) }
    return if (allowed.isEmpty()) null else Received(allowed, intent.type)
  }

  private fun streamOf(intent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
    }

  private fun streamsOf(intent: Intent): List<Uri> =
    if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM) ?: emptyList()
    }

  private fun isOtherAppsContent(context: Context, uri: Uri): Boolean {
    if (uri.scheme != ContentResolver.SCHEME_CONTENT) return false
    val authority = uri.authority ?: return false
    val provider = try {
      context.packageManager.resolveContentProvider(authority, 0)
    } catch (_: Exception) {
      null
    }
    return provider?.packageName != context.packageName
  }

  private fun copyAll(received: Received, maxFiles: Int, maxBytes: Long): Map<String, Any?> {
    val context = appContext.reactContext ?: return mapOf("files" to emptyList<Map<String, Any?>>(), "overLimit" to received.uris.size)
    val resolver = context.contentResolver
    val dir = File(context.cacheDir, "shared-in").apply { mkdirs() }
    val files = received.uris.take(maxFiles).map { uri -> copyOne(resolver, dir, uri, received.type, maxBytes) }
    return mapOf("files" to files, "overLimit" to (received.uris.size - maxFiles).coerceAtLeast(0))
  }

  private fun copyOne(resolver: ContentResolver, dir: File, uri: Uri, intentType: String?, maxBytes: Long): Map<String, Any?> {
    var name: String? = null
    var declaredSize: Long? = null
    try {
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val s = c.getColumnIndex(OpenableColumns.SIZE)
          if (n >= 0 && !c.isNull(n)) name = c.getString(n)
          if (s >= 0 && !c.isNull(s)) declaredSize = c.getLong(s)
        }
      }
    } catch (_: Exception) {
      // Name and size are optional; the copy below decides whether the file is readable.
    }
    val type = (try { resolver.getType(uri) } catch (_: Exception) { null }) ?: intentType?.takeIf { !it.contains('*') }
    fun result(status: String, path: File? = null, size: Long? = declaredSize) =
      mapOf("uri" to path?.let { Uri.fromFile(it).toString() }, "name" to name, "mimeType" to type, "size" to size?.toDouble(), "status" to status)

    if (type != null && type != "application/pdf" && !type.startsWith("image/")) return result("unsupported")
    if ((declaredSize ?: 0L) > maxBytes) return result("too_large")

    val out = File(dir, UUID.randomUUID().toString())
    var copied = 0L
    try {
      val input = resolver.openInputStream(uri) ?: return result("unreadable")
      input.use { stream ->
        out.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            val n = stream.read(buffer)
            if (n < 0) break
            copied += n
            if (copied > maxBytes) {
              output.close()
              out.delete()
              return result("too_large", size = copied)
            }
            output.write(buffer, 0, n)
          }
        }
      }
    } catch (_: Exception) {
      out.delete()
      return result("unreadable")
    }
    return result("ok", out, copied)
  }
}
