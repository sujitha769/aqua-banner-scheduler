import {
  Card,
  Page,
  Layout,
  TextContainer,
  Text,
  Button,
  Spinner,
  TextField,
  DataTable,
  Badge,
  Stack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useEffect } from "react";

export default function HomePage() {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [alt, setAlt] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [uploading, setUploading] = useState(false);
  const [url, setUrl] = useState(null);

  // banner list
  const [banners, setBanners] = useState([]);
  const [counts, setCounts] = useState({
    active: 0,
    scheduled: 0,
    expired: 0,
  });

  // fetch banners on load
  useEffect(() => {
    fetchBanners();
  }, []);

  const fetchBanners = async () => {
    try {
      const res = await fetch("/api/banners");
      const data = await res.json();
      setBanners(data.banners || []);
      setCounts(data.counts || { active: 0, scheduled: 0, expired: 0 });
    } catch (err) {
      console.error("Fetch banners error:", err);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append("banner", file);
    formData.append("title", title);
    formData.append("alt", alt);
    formData.append("startDate", startDate);
    formData.append("endDate", endDate);

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (data.url) {
        setUrl(data.url);
        // refresh banners after upload
        fetchBanners();
      } else {
        alert("Upload failed: " + JSON.stringify(data));
      }
    } catch (err) {
      console.error("Upload error:", err);
      alert("Error: " + err.message);
    } finally {
      setUploading(false);
    }
  };

  // delete banner
  const handleDelete = async (id) => {
    if (!confirm("Are you sure you want to delete this banner?")) return;
    try {
      await fetch(`/api/banners/${id}`, { method: "DELETE" });
      fetchBanners();
    } catch (err) {
      console.error("Delete error:", err);
    }
  };

  // prepare table rows
  const bannerRows = banners.map((b) => [
    b.title || "-",
    b.alt || "-",
    <Badge
      key={b._id}
      status={
        b.status === "Active"
          ? "success"
          : b.status === "Expired"
          ? "critical"
          : "warning"
      }
    >
      {b.status}
    </Badge>,
    <Button plain onClick={() => alert("Edit coming soon!")}>
      Edit
    </Button>,
    <Button plain destructive onClick={() => handleDelete(b._id)}>
      Delete
    </Button>,
  ]);

  const countRows = [
    ["Active", counts.active],
    ["Scheduled", counts.scheduled],
    ["Expired", counts.expired],
  ];

  return (
    <Page fullWidth>
      <TitleBar title="Banner Upload App" />
      <Layout>
        {/* Upload Section */}
        <Layout.Section>
          <Card>
            <TextContainer>
              <Text as="h2" variant="headingMd">
                Upload a Banner Image with Metadata
              </Text>

              <form onSubmit={handleSubmit}>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => setFile(e.target.files[0])}
                  style={{ marginTop: "10px", marginBottom: "10px" }}
                />

                <TextField
                  label="Title"
                  value={title}
                  onChange={setTitle}
                  autoComplete="off"
                />

                <TextField
                  label="Alt Text"
                  value={alt}
                  onChange={setAlt}
                  autoComplete="off"
                />

                <div style={{ marginTop: "10px" }}>
                  <label>Start Date:</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    style={{ marginLeft: "10px" }}
                  />
                </div>

                <div style={{ marginTop: "10px" }}>
                  <label>End Date:</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    style={{ marginLeft: "10px" }}
                  />
                </div>

                <div style={{ marginTop: "15px" }}>
                  <Button primary submit disabled={uploading}>
                    {uploading ? (
                      <Spinner accessibilityLabel="Uploading" />
                    ) : (
                      "Upload"
                    )}
                  </Button>
                </div>
              </form>

              {url && (
                <div style={{ marginTop: "20px" }}>
                  <Text as="p">✅ Uploaded to Shopify Files:</Text>
                  <img
                    src={url}
                    alt="Banner"
                    style={{ maxWidth: "400px", marginTop: "10px" }}
                  />
                </div>
              )}
            </TextContainer>
          </Card>
        </Layout.Section>

        {/* Banner Table */}
        <Layout.Section>
          <Card title="Banners List">
            {bannerRows.length > 0 ? (
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                ]}
                headings={[
                  "Banner Name",
                  "Alt Text",
                  "Status",
                  "Edit",
                  "Delete",
                ]}
                rows={bannerRows}
              />
            ) : (
              <Text alignment="center" as="p">
                No banners found
              </Text>
            )}
          </Card>
        </Layout.Section>

        {/* Summary Counts */}
        <Layout.Section>
          <Card title="Summary">
            <DataTable
              columnContentTypes={["text", "numeric"]}
              headings={["Status", "Count"]}
              rows={countRows}
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
