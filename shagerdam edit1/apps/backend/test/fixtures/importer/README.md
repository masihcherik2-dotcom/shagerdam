# Importer fixtures

Offline inputs for the product importer's unit and E2E tests.

| File | Origin |
| --- | --- |
| `digikala-dkp-13196935.json` | Response of `GET https://api.digikala.com/v2/product/13196935/` captured 2026-09-28, trimmed to the fields the parser reads (long review texts shortened to their first sentence). Values, including trailing spaces, `\r\n` and the Arabic «ك» in «امكان», are verbatim. |
| `digikala-dkp-18010600.json` | Response of `GET https://api.digikala.com/v2/product/18010600/` (Galaxy S24 Ultra) captured 2026-09-28, trimmed. Titles, gallery and specification values are verbatim; only a subset of the specification groups is kept. The response's `category`/`brand` objects were not captured in full and are rebuilt from its `data_layer` (`item_category3`, `brand`). The group title «ارتباطات» of the second group was not captured and is assumed. The description combines two verbatim fragments of the expert review, including its `&zwnj;` entity. |
| `woocommerce-product.html` | Markup of a WooCommerce 8.x single-product page (Yoast `@graph` JSON-LD, gallery with `data-large_image`, `table.woocommerce-product-attributes`) with an invented product. |
| `shopify-product.html` | Shopify `ProductGroup` JSON-LD with `hasVariant` and `width=` resized CDN images. |
| `microdata-product.html` | A product described only with schema.org microdata (`itemscope`/`itemprop`). |

Digikala cannot be reached from the CI network, so these captures stand in for live responses.
