package online.ainiannian.garden;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

final class PrivateFiles {
    static String randomHex(int bytes) {
        byte[] value = new byte[bytes]; new SecureRandom().nextBytes(value);
        StringBuilder hex = new StringBuilder();
        for (byte b : value) hex.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return hex.toString();
    }
    static String text(File file) throws IOException {
        try (InputStream in = new FileInputStream(file); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            copy(in, out); return out.toString("UTF-8");
        }
    }
    static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[32768]; int count;
        while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
    }
    static void write(File file, String text) throws IOException {
        File parent = file.getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("无法创建本机目录");
        AtomicFile atomic = new AtomicFile(file); FileOutputStream out = null;
        try { out = atomic.startWrite(); out.write(text.getBytes(StandardCharsets.UTF_8)); atomic.finishWrite(out); }
        catch (IOException e) { if (out != null) atomic.failWrite(out); throw e; }
    }
    static void extract(Context context, File target) throws Exception {
        File version = new File(target, ".asset-version");
        String build = Long.toString(context.getPackageManager().getPackageInfo(context.getPackageName(), 0).lastUpdateTime);
        if (version.isFile() && text(version).equals(build)) return;
        if (!target.isDirectory() && !target.mkdirs()) throw new IOException("无法创建执行器目录");
        String root = target.getCanonicalPath() + File.separator;
        java.util.Set<String> included = new java.util.HashSet<>();
        try (ZipInputStream zip = new ZipInputStream(context.getAssets().open("engine.zip"))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                File file = new File(target, entry.getName());
                if (!file.getCanonicalPath().startsWith(root)) throw new IOException("执行器资源路径不合法");
                if (entry.isDirectory()) { if (!file.isDirectory() && !file.mkdirs()) throw new IOException("资源目录不可写"); included.add(file.getCanonicalPath()); continue; }
                File parent = file.getParentFile();
                if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("资源目录不可写");
                try (FileOutputStream out = new FileOutputStream(file)) { copy(zip, out); }
                included.add(file.getCanonicalPath());
            }
        }
        // A newer archive may drop files an earlier version shipped; leftovers would keep running beside the new code.
        removeStale(target, included, version.getCanonicalPath());
        write(version, build);
    }
    private static void removeStale(File dir, java.util.Set<String> included, String versionPath) throws IOException {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) {
            String path = child.getCanonicalPath();
            if (child.isDirectory()) { removeStale(child, included, versionPath); if (!included.contains(path) && child.listFiles().length == 0) child.delete(); }
            else if (!included.contains(path) && !path.equals(versionPath)) child.delete();
        }
    }
    // The game credential key is encrypted by Android Keystore, never baked into the APK.
    static synchronized String credentialKey(Context context) throws Exception {
        final String alias = "garden-local-credentials-v1";
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(alias)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        SecretKey key = (SecretKey) store.getKey(alias, null);
        File file = new File(context.getFilesDir(), "credential-key.enc");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        if (file.isFile()) {
            JSONObject saved = new JSONObject(text(file));
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.getDecoder().decode(saved.getString("iv"))));
            return new String(cipher.doFinal(Base64.getDecoder().decode(saved.getString("data"))), StandardCharsets.US_ASCII);
        }
        String value = randomHex(32); cipher.init(Cipher.ENCRYPT_MODE, key);
        JSONObject saved = new JSONObject().put("iv", Base64.getEncoder().encodeToString(cipher.getIV()))
            .put("data", Base64.getEncoder().encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.US_ASCII))));
        write(file, saved.toString()); return value;
    }
}
